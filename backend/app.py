import os, uuid, math, io, threading
from pathlib import Path
from flask import Flask, request, jsonify, send_file, abort
from flask_cors import CORS
import numpy as np
import rasterio
from rasterio.enums import Resampling
from PIL import Image

BASE = Path(__file__).resolve().parent
UPLOADS = BASE / 'uploads'
UPLOADS.mkdir(exist_ok=True)
MAX_PREVIEW = 1600
TILE = 512
DATASETS = {}
LOCK = threading.Lock()

# Re-index uploaded originals after a backend restart.
def restore_datasets():
    for p in UPLOADS.glob('*'):
        if p.suffix.lower() not in ('.tif', '.tiff'):
            continue
        try:
            meta = scan_dataset(p)
            prefix = p.name.split('_', 1)[0]
            if len(prefix) == 12:
                meta['id'] = prefix
            meta['path'] = str(p)
            DATASETS[meta['id']] = meta
        except Exception:
            continue

app = Flask(__name__)
CORS(app)
app.config['MAX_CONTENT_LENGTH'] = 10 * 1024 * 1024 * 1024


def compute_band_stats(ds):
    maxdim = max(ds.width, ds.height)
    scale = min(1.0, 1600 / maxdim)
    out_h = max(1, int(ds.height * scale))
    out_w = max(1, int(ds.width * scale))
    stats = []
    for b in range(1, ds.count + 1):
        arr = ds.read(b, out_shape=(out_h, out_w), resampling=Resampling.bilinear, masked=True)
        arr_f = np.ma.filled(arr, np.nan).astype(np.float32)
        finite = arr_f[np.isfinite(arr_f)]
        if ds.nodata is not None:
            finite = finite[finite != ds.nodata]
        valid = finite[finite > 0] if (finite.size > 0 and np.min(finite) >= 0 and np.max(finite) > 0) else finite
        if valid.size == 0:
            valid = finite
        if valid.size > 0:
            lo, hi = np.percentile(valid, [2, 98])
            if hi <= lo: hi = lo + 1.0
        else:
            lo, hi = 0.0, 255.0
        stats.append({'lo': float(lo), 'hi': float(hi)})
    return stats


def scan_dataset(path: Path):
    with rasterio.open(path) as ds:
        maxdim = max(ds.width, ds.height)
        levels = int(math.ceil(math.log2(maxdim))) + 1 if maxdim > 1 else 1
        band_stats = compute_band_stats(ds)

        return {
            'id': path.stem,
            'name': path.name,
            'width': ds.width, 'height': ds.height,
            'bands': ds.count, 'dtype': str(ds.dtypes[0]),
            'crs': ds.crs.to_string() if ds.crs else None,
            'bounds': [ds.bounds.left, ds.bounds.bottom, ds.bounds.right, ds.bounds.top],
            'transform': list(ds.transform)[:6],
            'pixel_size': [abs(ds.transform.a), abs(ds.transform.e)],
            'nodata': ds.nodata,
            'min_zoom_level': 0, 'max_zoom_level': levels - 1,
            'tile_size': TILE,
            'band_stats': band_stats,
            'path': str(path)
        }


restore_datasets()

def get_ds(dataset_id):
    meta = DATASETS.get(dataset_id)
    if not meta: abort(404, 'Dataset not found')
    p = Path(meta['path'])
    if not p.exists(): abort(404, 'Raster file no longer exists')
    return p, meta


def get_band_stats(meta, path):
    with rasterio.open(path) as ds:
        stats = compute_band_stats(ds)
        meta['band_stats'] = stats
        return stats


def global_stretch(a, lo, hi):
    a = np.asarray(a, dtype=np.float32)
    finite = np.isfinite(a)
    if not finite.any(): return np.zeros(a.shape, np.uint8)
    if hi <= lo: hi = lo + 1.0
    out = (a - lo) / (hi - lo) * 255.0
    return np.clip(out, 0, 255).astype(np.uint8)


def encode_png(arr, rgb=True):
    if rgb:
        img = Image.fromarray(np.moveaxis(arr, 0, -1), 'RGB')
    else:
        img = Image.fromarray(arr, 'L').convert('RGB')
    bio = io.BytesIO(); img.save(bio, format='PNG', optimize=True); bio.seek(0)
    return bio


def read_preview(path, meta, bands, max_size=MAX_PREVIEW, stretch=True):
    stats = get_band_stats(meta, path)
    with rasterio.open(path) as ds:
        scale = min(1.0, max_size / max(ds.width, ds.height))
        out_h = max(1, int(ds.height * scale)); out_w = max(1, int(ds.width * scale))
        b = [int(x) for x in bands]
        b = [x for x in b if 1 <= x <= ds.count]
        if not b: b = [1]
        arr = ds.read(b, out_shape=(len(b), out_h, out_w), resampling=Resampling.bilinear, masked=True)
        arr = np.ma.filled(arr, np.nan).astype(np.float32)
        if len(b) == 1:
            st = stats[b[0] - 1]
            a = global_stretch(arr[0], st['lo'], st['hi']) if stretch else np.clip(arr[0], 0, 255).astype(np.uint8)
            return encode_png(a, False)
        while len(b) < 3: arr = np.vstack([arr, arr[-1:]])
        rgb_list = []
        for i in range(3):
            band_num = b[min(i, len(b) - 1)]
            st = stats[band_num - 1]
            rgb_list.append(global_stretch(arr[i], st['lo'], st['hi']))
        rgb = np.stack(rgb_list)
        return encode_png(rgb, True)


def tile_image(path, meta, level, x, y, bands, stretch=True):
    stats = get_band_stats(meta, path)
    with rasterio.open(path) as ds:
        maxdim = max(ds.width, ds.height)
        maxlevel = int(math.ceil(math.log2(maxdim)))
        if level < 0: abort(404)
        effective_level = min(level, maxlevel)
        scale = 2 ** (maxlevel - effective_level)
        full_w = math.ceil(ds.width / scale); full_h = math.ceil(ds.height / scale)
        left = x * TILE; top = y * TILE
        if left >= full_w or top >= full_h: abort(404)
        w = min(TILE, full_w - left); h = min(TILE, full_h - top)
        if w <= 0 or h <= 0: abort(404)
        
        win_x = left * scale
        win_y = top * scale
        win_w = min(ds.width - win_x, w * scale)
        win_h = min(ds.height - win_y, h * scale)
        if win_w <= 0 or win_h <= 0: abort(404)

        win = rasterio.windows.Window(win_x, win_y, win_w, win_h)
        b = [int(v) for v in bands]
        b = [v for v in b if 1 <= v <= ds.count]
        if not b: b = [1]
        arr = ds.read(b, window=win, out_shape=(len(b), h, w), resampling=Resampling.bilinear, masked=True)
        arr = np.ma.filled(arr, np.nan).astype(np.float32)
        if len(b) == 1:
            st = stats[b[0] - 1]
            out = global_stretch(arr[0], st['lo'], st['hi']) if stretch else np.clip(arr[0],0,255).astype(np.uint8)
            return encode_png(out, False)
        while len(b) < 3: arr = np.vstack([arr, arr[-1:]])
        rgb_list = []
        for i in range(3):
            band_num = b[min(i, len(b) - 1)]
            st = stats[band_num - 1]
            rgb_list.append(global_stretch(arr[i], st['lo'], st['hi']))
        rgb = np.stack(rgb_list)
        return encode_png(rgb, True)


def parse_bands(args, default=None):
    if default is None: default = [1,2,3]
    raw = args.get('bands')
    if not raw: return default
    try: return [int(x) for x in raw.split(',')]
    except Exception: return default


@app.get('/api/health')
def health(): return jsonify({'ok': True})

CHUNKS_DIR = BASE / 'chunks'
CHUNKS_DIR.mkdir(exist_ok=True)

@app.post('/api/upload')
def upload():
    f = request.files.get('file')
    if not f or not f.filename: return jsonify({'error':'No file supplied'}), 400
    if not f.filename.lower().endswith(('.tif','.tiff')): return jsonify({'error':'Only GeoTIFF files are supported'}), 400
    dataset_id = uuid.uuid4().hex[:12]
    safe = ''.join(c if c.isalnum() or c in '._-' else '_' for c in f.filename)
    path = UPLOADS / f'{dataset_id}_{safe}'
    f.save(path)
    try: meta = scan_dataset(path)
    except Exception as e:
        path.unlink(missing_ok=True); return jsonify({'error': f'Invalid GeoTIFF: {e}'}), 400
    meta['id'] = dataset_id; meta['path'] = str(path)
    with LOCK: DATASETS[dataset_id] = meta
    return jsonify({k:v for k,v in meta.items() if k != 'path'})

@app.post('/api/upload/chunk')
def upload_chunk():
    upload_id = request.form.get('upload_id')
    chunk_index = int(request.form.get('chunk_index', 0))
    total_chunks = int(request.form.get('total_chunks', 1))
    filename = request.form.get('filename', '')
    f = request.files.get('file')
    
    if not upload_id or not f or not filename:
        return jsonify({'error': 'Invalid chunk data'}), 400
    if not filename.lower().endswith(('.tif', '.tiff')):
        return jsonify({'error': 'Only GeoTIFF files are supported'}), 400

    chunk_dir = CHUNKS_DIR / upload_id
    chunk_dir.mkdir(parents=True, exist_ok=True)
    chunk_path = chunk_dir / f'{chunk_index}.part'
    f.save(chunk_path)

    uploaded_chunks = len(list(chunk_dir.glob('*.part')))
    if uploaded_chunks == total_chunks:
        dataset_id = uuid.uuid4().hex[:12]
        safe = ''.join(c if c.isalnum() or c in '._-' else '_' for c in filename)
        final_path = UPLOADS / f'{dataset_id}_{safe}'
        
        with open(final_path, 'wb') as outfile:
            for i in range(total_chunks):
                cp = chunk_dir / f'{i}.part'
                if cp.exists():
                    with open(cp, 'rb') as infile:
                        outfile.write(infile.read())
                    cp.unlink(missing_ok=True)
        
        try: chunk_dir.rmdir()
        except Exception: pass
        
        try:
            meta = scan_dataset(final_path)
        except Exception as e:
            final_path.unlink(missing_ok=True)
            return jsonify({'error': f'Invalid GeoTIFF: {e}'}), 400
            
        meta['id'] = dataset_id
        meta['path'] = str(final_path)
        with LOCK:
            DATASETS[dataset_id] = meta
            
        return jsonify({k: v for k, v in meta.items() if k != 'path'})
        
    return jsonify({'status': 'chunk_received', 'chunk_index': chunk_index, 'total_chunks': total_chunks})

@app.get('/api/datasets')
def datasets():
    with LOCK:
        dead = [k for k, v in DATASETS.items() if not Path(v['path']).exists()]
        for k in dead:
            DATASETS.pop(k, None)
        return jsonify([{k:v for k,v in m.items() if k != 'path'} for m in DATASETS.values()])

@app.delete('/api/datasets/<dataset_id>')
def delete_dataset(dataset_id):
    meta = DATASETS.pop(dataset_id, None)
    if not meta: return jsonify({'error':'Dataset not found'}), 404
    Path(meta['path']).unlink(missing_ok=True)
    return jsonify({'ok':True})

@app.get('/api/metadata/<dataset_id>')
def metadata(dataset_id):
    _, meta = get_ds(dataset_id)
    return jsonify({k:v for k,v in meta.items() if k != 'path'})

@app.get('/api/image/<dataset_id>.png')
def image_alias(dataset_id):
    return preview(dataset_id)

@app.get('/api/preview/<dataset_id>.png')
def preview(dataset_id):
    path, meta = get_ds(dataset_id)
    bands = parse_bands(request.args, [1,2,3] if meta['bands'] >= 3 else [1])
    try: return send_file(read_preview(path, meta, bands), mimetype='image/png', max_age=0)
    except Exception as e: return jsonify({'error':str(e)}), 500

@app.get('/api/tile/<dataset_id>/<int:level>/<int:x>/<int:y>.png')
def tile(dataset_id, level, x, y):
    path, meta = get_ds(dataset_id)
    bands = parse_bands(request.args, [1,2,3] if meta['bands'] >= 3 else [1])
    try: return send_file(tile_image(path, meta, level, x, y, bands), mimetype='image/png', max_age=86400)
    except Exception as e: return jsonify({'error':str(e)}), 500

@app.get('/api/histogram/<dataset_id>')
def histogram(dataset_id):
    path, meta = get_ds(dataset_id); band = int(request.args.get('band',1)); bins=int(request.args.get('bins',128))
    with rasterio.open(path) as ds:
        if band < 1 or band > ds.count: return jsonify({'error':'Invalid band'}),400
        scale = min(1.0, 1200/max(ds.width, ds.height))
        a = ds.read(band, out_shape=(max(1,int(ds.height*scale)),max(1,int(ds.width*scale))), resampling=Resampling.nearest, masked=True)
        a = np.asarray(a.compressed(), dtype=np.float64)
    if a.size == 0: return jsonify({'bins':[], 'counts':[]})
    counts, edges = np.histogram(a, bins=bins)
    centers=((edges[:-1]+edges[1:])/2).tolist()
    return jsonify({'bins':centers,'counts':counts.tolist(),'min':float(a.min()),'max':float(a.max()),'mean':float(a.mean()),'std':float(a.std()),'median':float(np.median(a))})

@app.get('/api/scatter/<dataset_id>')
def scatter(dataset_id):
    path, meta = get_ds(dataset_id); b1=int(request.args.get('band1',1)); b2=int(request.args.get('band2',2)); n=min(int(request.args.get('samples',5000)),20000)
    with rasterio.open(path) as ds:
        if not (1 <= b1 <= ds.count and 1 <= b2 <= ds.count): return jsonify({'error':'Invalid band'}),400
        scale=min(1.0, math.sqrt(n/(ds.width*ds.height))*3)
        h=max(1,int(ds.height*scale)); w=max(1,int(ds.width*scale))
        a=ds.read([b1,b2],out_shape=(2,h,w),resampling=Resampling.nearest,masked=True)
        x=np.asarray(a[0].compressed(),float); y=np.asarray(a[1].compressed(),float)
        m=np.isfinite(x)&np.isfinite(y); x=x[m]; y=y[m]
        if len(x)>n:
            rng=np.random.default_rng(7); idx=rng.choice(len(x),n,replace=False); x=x[idx]; y=y[idx]
    return jsonify({'x':x.tolist(),'y':y.tolist()})

@app.post('/api/profile/<dataset_id>')
def profile(dataset_id):
    path, meta = get_ds(dataset_id); body=request.get_json(force=True); p1=body.get('start'); p2=body.get('end'); bands=body.get('bands') or [1]
    if not p1 or not p2: return jsonify({'error':'start/end required'}),400
    x0,y0=float(p1[0]),float(p1[1]); x1,y1=float(p2[0]),float(p2[1]); length=math.hypot(x1-x0,y1-y0); n=max(2,min(1000,int(length)+1))
    xs=np.linspace(x0,x1,n); ys=np.linspace(y0,y1,n)
    with rasterio.open(path) as ds:
        cols=np.clip(np.round(xs).astype(int),0,ds.width-1); rows=np.clip(np.round(ys).astype(int),0,ds.height-1)
        out=[]
        for b in bands:
            if 1 <= int(b) <= ds.count:
                vals=ds.read(int(b), window=rasterio.windows.Window(int(cols.min()),int(rows.min()),int(cols.max()-cols.min()+1),int(rows.max()-rows.min()+1)))
                v=[]
                for c,r in zip(cols,rows): v.append(float(vals[r-int(rows.min()),c-int(cols.min())]))
                out.append({'band':int(b),'values':v})
    return jsonify({'distance':np.linspace(0,length,n).tolist(),'series':out})

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=int(os.environ.get('PORT', 5000)), threaded=True)
