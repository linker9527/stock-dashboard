// 统一的外部请求工具：所有数据源必须走这里，不允许裸 fetch。
//
// 背景：Yahoo 实测会「TCP 挂起」而非返回错误码，fetch 默认无超时会一直卡住，
// 主备降级链因此永远不会触发。东财/新浪/腾讯同样存在这种故障模式，
// 所以超时逻辑必须下沉到每个数据源，而不是只在 Yahoo 那一处。

export const DEFAULT_TIMEOUT_MS = 6000

export function makeTimeoutController(timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return { signal: controller.signal, cleanup: () => clearTimeout(timer) }
}

// 带超时的 fetch。超时抛出的错误 message 包含 'timeout'，便于上层识别。
export async function fetchTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const { signal, cleanup } = makeTimeoutController(timeoutMs)
  try {
    return await fetch(url, { ...options, signal })
  } catch (e) {
    // 统一把 AbortError 转成可读的超时错误
    if (e.name === 'AbortError' || /abort/i.test(e.message || '')) {
      throw new Error('timeout after ' + timeoutMs + 'ms')
    }
    throw e
  } finally {
    cleanup()
  }
}
