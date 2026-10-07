// 等结果的时限：到时间还没回来就当作没有（原来的请求照样在后台做完，结果进缓存）。

/** 最多等 ms 毫秒；超时或出错都返回 null（出错时交给 onError 记日志） */
export function within<T>(promise: Promise<T>, ms: number, onError?: (error: unknown) => void): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), Math.max(0, ms))
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        onError?.(error)
        resolve(null)
      },
    )
  })
}
