const MODE_SUFFIXES = [
  ['-deep-research', { chatMode: 'deep_research', mode: 'deep_research' }],
  ['-deep_research', { chatMode: 'deep_research', mode: 'deep_research' }],
  ['-web-dev', { chatMode: 'web_dev', mode: 'webdev' }],
  ['-thinking', { chatMode: 't2t', forceThinking: true, mode: 'thinking' }],
  ['-webdev', { chatMode: 'web_dev', mode: 'webdev' }],
  ['-image', { chatMode: 't2i', mode: 'image' }],
  ['-video', { chatMode: 't2v', mode: 'video' }],
  ['-slides', { chatMode: 'slides', mode: 'slides' }],
  ['-t2i', { chatMode: 't2i', mode: 'image' }],
  ['-t2v', { chatMode: 't2v', mode: 'video' }],
];

export function parseModelMode(modelId = '') {
  const requestedModel = String(modelId || '').trim();
  const lowered = requestedModel.toLowerCase();

  for (const [suffix, config] of MODE_SUFFIXES) {
    if (lowered.endsWith(suffix)) {
      return {
        requestedModel,
        baseModel: requestedModel.slice(0, -suffix.length),
        chatMode: config.chatMode,
        forceThinking: !!config.forceThinking,
        mode: config.mode,
      };
    }
  }

  return {
    requestedModel,
    baseModel: requestedModel,
    chatMode: 't2t',
    forceThinking: false,
    mode: 'chat',
  };
}

export function modelCapabilitiesForMode(mode) {
  const capabilities = {};
  if (mode.forceThinking) capabilities.thinking = true;
  if (mode.mode === 'deep_research') {
    capabilities.deep_research = true;
    capabilities.search = true;
  }
  if (mode.mode === 'image') capabilities.image_gen = true;
  if (mode.mode === 'video') capabilities.video_gen = true;
  if (mode.mode === 'webdev') capabilities.web_dev = true;
  if (mode.mode === 'slides') capabilities.slides = true;
  return capabilities;
}
