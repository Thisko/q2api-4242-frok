const BROWSER_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'accept-encoding': 'gzip, deflate, br',
  'sec-ch-ua': '"Not;A=Brand";v="8", "Chromium";v="150", "Google Chrome";v="150"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
  'origin': 'https://chat.qwen.ai',
  'source': 'web',
  'version': '0.2.80',
  'bx-v': '2.5.36',
};

export function requestHeaders(extra = {}) {
  return {
    'content-type': 'application/json',
    'accept': 'application/json, text/plain, */*',
    ...BROWSER_HEADERS,
    ...extra,
  };
}

export function chatHeaders(token, chatId, extra = {}) {
  return {
    'authorization': `Bearer ${token}`,
    'content-type': 'application/json',
    'accept': 'application/json',
    'x-accel-buffering': 'no',
    'timezone': new Date().toUTCString(),
    'referer': `https://chat.qwen.ai/c/${chatId}`,
    ...BROWSER_HEADERS,
    ...extra,
  };
}
