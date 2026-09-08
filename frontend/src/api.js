import axios from 'axios';
const api = axios.create({ baseURL: '/api' });

export const uploadRaster = async (file, onProgress) => {
  const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB per chunk
  if (file.size <= CHUNK_SIZE) {
    const d = new FormData();
    d.append('file', file);
    return api.post('/upload', d, {
      headers: { 'Content-Type': 'multipart/form-data' },
      onUploadProgress: (evt) => {
        if (onProgress && evt.total) {
          onProgress(Math.round((evt.loaded * 100) / evt.total));
        }
      }
    });
  }

  const uploadId = `upload_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  let lastResponse = null;

  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(file.size, start + CHUNK_SIZE);
    const chunk = file.slice(start, end);

    const formData = new FormData();
    formData.append('upload_id', uploadId);
    formData.append('chunk_index', i);
    formData.append('total_chunks', totalChunks);
    formData.append('filename', file.name);
    formData.append('file', chunk, file.name);

    lastResponse = await api.post('/upload/chunk', formData, {
      headers: { 'Content-Type': 'multipart/form-data' }
    });

    if (onProgress) {
      onProgress(Math.round(((i + 1) * 100) / totalChunks));
    }
  }

  return lastResponse;
};

export const metadata = id => api.get(`/metadata/${id}`);
export const histogram = (id, b) => api.get(`/histogram/${id}?band=${b}`);
export const scatter = (id, a, b) => api.get(`/scatter/${id}?band1=${a}&band2=${b}`);
export const profile = (id, body) => api.post(`/profile/${id}`, body);

export default api;
