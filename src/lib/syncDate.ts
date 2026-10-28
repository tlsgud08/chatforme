/** Reserved display metadata; raw messages and model payloads are preserved. */
export function stripSyncDateTags(content: string, streaming = false): string {
  let visible = content.replace(/\{\{sync_date::([^{}\r\n]{0,200})\}\}/g, '');
  if (streaming) {
    const start = visible.lastIndexOf('{{');
    if (start >= 0) {
      const suffix = visible.slice(start);
      if ('{{sync_date::'.startsWith(suffix) || (suffix.startsWith('{{sync_date::') && !suffix.includes('}}'))) visible = visible.slice(0, start);
    }
  }
  return visible;
}
