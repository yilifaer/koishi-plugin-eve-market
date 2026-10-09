// 密钥文件（§8.2）：<实例>/data/eve-market/secret.key，权限 0600，密钥和 keyId 绝不写进日志；
// 换了密钥以后旧密文打不开（档案要重新授权）。

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AesSecretBox, SECRET_KEY_FILE, loadSecretKey, openSecretBox } from '../../src/bot/ports'
import type { Logger } from '../../src/core/ports'

class Lines implements Logger {
  readonly all: string[] = []
  debug(...a: unknown[]) { this.all.push(a.map(String).join(' ')) }
  info(...a: unknown[]) { this.all.push(a.map(String).join(' ')) }
  warn(...a: unknown[]) { this.all.push(a.map(String).join(' ')) }
  error(...a: unknown[]) { this.all.push(a.map(String).join(' ')) }
}

let dir: string

beforeEach(async () => {
  dir = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'eve-market-secret-')), 'data', 'eve-market')
})

afterEach(async () => {
  await fs.rm(path.dirname(path.dirname(dir)), { recursive: true, force: true })
})

describe('secret.key', () => {
  it('is created once; neither the key nor its keyId appear in the log', async () => {
    const logger = new Lines()
    const box = await openSecretBox(dir, logger)
    const key = (await fs.readFile(path.join(dir, SECRET_KEY_FILE), 'utf8')).trim()
    expect(box.keyId).toMatch(/^[0-9a-f]{8}$/)
    expect(logger.all).toHaveLength(1)
    const log = logger.all.join('\n')
    expect(log).not.toContain(key)
    expect(log).not.toContain(box.keyId)

    const again = await openSecretBox(dir, logger)
    expect(again.keyId).toBe(box.keyId)
    expect(again.open(box.seal('refresh-token'))).toBe('refresh-token')
    expect(logger.all).toHaveLength(1)
  })

  it.skipIf(process.platform === 'win32')('tightens a key file that others can read back to 0600', async () => {
    const key = await loadSecretKey(dir)
    const file = path.join(dir, SECRET_KEY_FILE)
    await fs.chmod(file, 0o644)
    expect(await loadSecretKey(dir)).toEqual(key)
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
  })

  it('a different key cannot open old ciphertext (the profile has to be authorized again)', async () => {
    const old = new AesSecretBox(Buffer.alloc(32, 1))
    const sealed = old.seal('refresh-token')
    const fresh = new AesSecretBox(Buffer.alloc(32, 2))
    expect(fresh.keyId).not.toBe(old.keyId)
    expect(() => fresh.open(sealed)).toThrow()
    // 错误信息里不带密文和明文
    try {
      fresh.open(sealed)
    } catch (e) {
      expect(String((e as Error).message)).not.toContain('refresh-token')
      expect(String((e as Error).message)).not.toContain(sealed)
    }
  })

  it('an unreadable key file disables only sealing and opening', async () => {
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, SECRET_KEY_FILE), 'not a key\n')
    const logger = new Lines()
    const box = await openSecretBox(dir, logger)
    expect(box.keyId).toBe('')
    expect(() => box.seal('x')).toThrow()
    expect(logger.all.join('\n')).not.toContain('not a key')
  })
})
