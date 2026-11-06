export const ATTACHMENT_TYPES: Record<string, string> = {
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  html: 'text/html',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};
export const ATTACHMENT_ACCEPT = Object.keys(ATTACHMENT_TYPES)
  .map((type) => `.${type}`)
  .join(',');
export const attachmentType = (file: File) =>
  ATTACHMENT_TYPES[file.name.split('.').pop()?.toLowerCase() ?? ''];
export const uploadAttachmentFile = (
  upload: { url: string; fields?: Record<string, string>; mimeType?: string },
  file: File,
  onProgress?: (value: number) => void,
) =>
  new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open(upload.fields ? 'POST' : 'PUT', upload.url);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(Math.round((event.loaded / event.total) * 100));
    };
    request.onerror = () => reject(new Error(`Failed to upload ${file.name}`));
    request.onload = () =>
      request.status >= 200 && request.status < 300
        ? resolve()
        : reject(new Error(`Failed to upload ${file.name}`));
    if (upload.fields) {
      const form = new FormData();
      for (const [name, value] of Object.entries(upload.fields)) form.append(name, value);
      form.append('file', file);
      request.send(form);
    } else {
      request.setRequestHeader('Content-Type', upload.mimeType || attachmentType(file));
      request.send(file);
    }
  });
