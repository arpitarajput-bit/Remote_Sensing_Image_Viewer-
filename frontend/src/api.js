import axios from 'axios';
const api=axios.create({baseURL:'/api'});
export const uploadRaster=f=>{const d=new FormData();d.append('file',f);return api.post('/upload',d,{headers:{'Content-Type':'multipart/form-data'}})};
export const metadata=id=>api.get(`/metadata/${id}`); export const histogram=(id,b)=>api.get(`/histogram/${id}?band=${b}`); export const scatter=(id,a,b)=>api.get(`/scatter/${id}?band1=${a}&band2=${b}`); export const profile=(id,body)=>api.post(`/profile/${id}`,body);
export default api;
