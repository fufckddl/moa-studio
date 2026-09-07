export function chatWidthBounds(viewportWidth: number) {
  const max = Math.max(1, Math.floor(viewportWidth / 2));
  return { min: Math.min(320, max), max };
}

export function clampChatWidth(width: number, viewportWidth: number) {
  const { min, max } = chatWidthBounds(viewportWidth);
  return Math.max(min, Math.min(max, width));
}
