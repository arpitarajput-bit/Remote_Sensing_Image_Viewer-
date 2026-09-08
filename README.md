# GeoTIFF Studio — Remote Sensing Image Viewer

A professional dark GIS/remote-sensing workstation UI based on the supplied blueprint. It keeps the **original GeoTIFF as the only raster source** and reads only the required raster windows for previews and tiles; it does not create COG or pyramid copies.

## Implemented

- React + Vite frontend
- Python + Flask backend
- Rasterio + NumPy + Pillow
- GeoTIFF upload/import
- Multiple dataset containers with select/delete
- GeoTIFF metadata (dimensions, bands, CRS, bounds, pixel size, dtype, NoData)
- Large-raster tiled viewport using OpenSeadragon
- Low-resolution overview level first, then higher-resolution tiles on zoom/pan
- Tile requests are windowed reads from the original GeoTIFF
- OpenSeadragon navigator/minimap synchronized with the main viewport
- Smooth mouse-wheel zoom and drag pan
- RGB band selection
- Single-band/grayscale rendering
- Histogram with statistics
- Band-vs-band scatter plot
- Two-point profile sampling from the viewport
- RGB preview panel
- Pixel-coordinate readout
- Metadata dialog
- Responsive dark-blue professional UI matching the supplied blueprint structure

## Requirements

- Windows 10/11, macOS, or Linux
- Python 3.10–3.13 recommended
- Node.js 18+ (20 LTS recommended)
- A browser such as Chrome or Edge

> Rasterio installation can be platform-specific. The supplied requirements use current Rasterio wheels where available.

## Windows PowerShell — first run

Open PowerShell in the project root.

### 1. Backend

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
python app.py
```

Leave this PowerShell window running.

Backend: http://127.0.0.1:5000

### 2. Frontend

Open a **second** PowerShell window:

```powershell
cd frontend
npm install
npm run dev
```

Open the URL printed by Vite, normally:

http://127.0.0.1:3000/

## Use

1. Click **Import Rasters**.
2. Select a `.tif` or `.tiff` GeoTIFF.
3. The file becomes a dataset container immediately after upload.
4. The first visible image level is a low-resolution overview.
5. Zoom in: OpenSeadragon requests only the visible higher-resolution tiles.
6. Pan: only newly visible tiles are requested.
7. Use the top RGB controls to select bands.
8. Use Histogram / Band Compare / Profile Plot for analysis.
9. Use Metadata to inspect raster information.

## API

- `POST /api/upload` — import GeoTIFF
- `GET /api/datasets` — current dataset list
- `DELETE /api/datasets/<id>` — delete dataset and uploaded source
- `GET /api/metadata/<id>` — metadata
- `GET /api/preview/<id>.png` — overview preview
- `GET /api/tile/<id>/<level>/<x>/<y>.png` — on-demand tile
- `GET /api/histogram/<id>` — histogram/statistics
- `GET /api/scatter/<id>` — band scatter samples
- `POST /api/profile/<id>` — profile sampling
- `GET /api/health` — health check

## Architecture

```text
Browser / React
      |
      | REST + PNG tiles
      v
Flask API
      |
      v
Rasterio / GDAL
      |
      v
Original GeoTIFF
```

No browser-side full-raster transfer is required for navigation. Tile generation reads a raster window and resamples it directly from the uploaded source.

## Important operational note

This project is designed as a serious development foundation for remote-sensing visualization, but it is **not certified for operational ISRO production use**. Before deployment in a real operational environment, add institutional authentication, audit logging, secure storage, access controls, malware/file validation, reverse proxy/TLS, persistent dataset indexing, worker queues, observability, load testing, and validation against the specific sensor products and coordinate systems used by the target organization.
