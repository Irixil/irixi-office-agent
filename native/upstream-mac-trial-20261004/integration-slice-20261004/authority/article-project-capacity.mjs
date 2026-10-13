export const ARTICLE_PROJECT_CAPACITY = Object.freeze({
  maxFiles: 8,
  maxSourceBytes: 124 * 1024,
  maxFramingBytes: 2 * 1024,
  maxReviewBytes: 126 * 1024,
  maxNativePromptBytes: 144 * 1024,
});

export function assertArticleNativePrompt(prompt) {
  if (typeof prompt !== 'string' || !prompt || Buffer.byteLength(prompt) > ARTICLE_PROJECT_CAPACITY.maxNativePromptBytes) {
    throw new Error(`Native article project prompt is empty or exceeds the fixed ${ARTICLE_PROJECT_CAPACITY.maxNativePromptBytes / 1024} KiB preflight limit`);
  }
  return prompt;
}
