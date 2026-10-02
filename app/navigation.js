// Lesson addresses and keyboard shortcuts. Kept free of DOM access so they can be unit tested.

export const speeds = [.5, 1, 2, 3];

export function lessonFromHash(hash) {
  const match = /^#lesson=(.+)$/.exec(hash);
  try { return match ? decodeURIComponent(match[1]) : undefined; } catch { return undefined; }
}
export function lessonHash(id) { return `#lesson=${encodeURIComponent(id)}`; }

// The keyframe after (or before) `time`; past either end it stays on the last (or first) one.
export function adjacentKeyframe(keyframes, time, direction) {
  if (!keyframes.length) return undefined;
  const target = direction > 0 ? keyframes.find(frame => frame.at > time + 1e-6) : keyframes.findLast(frame => frame.at < time - 1e-6);
  return target ?? (direction > 0 ? keyframes.at(-1) : keyframes[0]);
}

// `typing`: focus is in a text field, slider or menu. `onControl`: focus is on a button-like
// element, where Space must keep activating that element.
export function shortcutFor({key, altKey, ctrlKey, metaKey}, {typing = false, onControl = false} = {}) {
  if (altKey || ctrlKey || metaKey || typing) return null;
  if (key === ' ') return onControl ? null : {type: 'toggle'};
  if (key === 'k' || key === 'K') return {type: 'toggle'};
  if (key === 'ArrowRight' || key === 'ArrowLeft') return {type: 'keyframe', direction: key === 'ArrowRight' ? 1 : -1};
  if (key === ']' || key === '[') return {type: 'lesson', direction: key === ']' ? 1 : -1};
  if (/^[1-4]$/.test(key)) return {type: 'speed', value: speeds[Number(key) - 1]};
  if (key === '0') return {type: 'reset'};
  return null;
}
