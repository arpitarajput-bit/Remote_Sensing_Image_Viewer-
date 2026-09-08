import React, { useEffect, useRef, useState } from 'react';
import OpenSeadragon from 'openseadragon';
import Plotly from 'plotly.js-dist-min';
import { Upload, Trash2, RotateCcw, Map, SlidersHorizontal, BarChart3, ScatterChart, LineChart, MousePointer2, Image as ImageIcon, Layers, Info, Maximize2, ZoomIn, ZoomOut, Hand, ChevronDown, X, Activity, Plus, Folder } from 'lucide-react';
import api, { uploadRaster, histogram, scatter, profile } from './api';

const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, errorInfo) {
    console.error("GeoTIFF Studio caught error:", error, errorInfo);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#06111f', color: '#d9e7f5', textAlign: 'center', padding: '20px' }}>
          <h2 style={{ fontSize: '20px', marginBottom: '10px', color: '#f87171' }}>Application State Recovery</h2>
          <p style={{ color: '#8eaac5', fontSize: '12px', maxWidth: '440px', marginBottom: '20px', lineHeight: '1.5' }}>
            An unexpected render error occurred. Click below to clear stored state and reload the application.
          </p>
          <button
            onClick={() => {
              try { localStorage.clear(); } catch (e) {}
              window.location.reload();
            }}
            style={{ background: '#0789ff', color: '#fff', border: 'none', padding: '10px 22px', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}
          >
            Reset State & Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function App() {
  const viewerRef = useRef(null);
  const swipeViewerRef = useRef(null);
  const viewerWrapRef = useRef(null);
  const osdRef = useRef(null);
  const osdSwipeRef = useRef(null);
  const fileRef = useRef(null);
  const chartRefs = useRef({});

  // Backend datasets list
  const [datasets, setDatasets] = useState([]);
  const [active, setActive] = useState(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('Ready');

  // Swipe Compare State
  const [swipeMode, setSwipeMode] = useState(false);
  const [swipeCompareId, setSwipeCompareId] = useState(null);
  const [swipePos, setSwipePos] = useState(50);

  // Containers state with array safety check
  const [containers, setContainers] = useState(() => {
    try {
      const saved = localStorage.getItem('geotiff_containers');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch (e) {}
    return [{ id: 'container-1', name: 'Container 1', datasetIds: [], history: {} }];
  });

  const [activeContainerId, setActiveContainerId] = useState(() => {
    try {
      const saved = localStorage.getItem('geotiff_active_container');
      if (saved) return saved;
    } catch (e) {}
    return 'container-1';
  });

  // Container modal state
  const [showContainerModal, setShowContainerModal] = useState(false);
  const [pendingFile, setPendingFile] = useState(null);

  // Analysis & Viewport UI state
  const [bands, setBands] = useState([1, 2, 3]);
  const [mode, setMode] = useState('rgb');
  const [analysis, setAnalysis] = useState('hist');
  const [histBand, setHistBand] = useState(1);
  const [scatterBands, setScatterBands] = useState([1, 2]);
  const [profileMode, setProfileMode] = useState(false);
  const [profilePts, setProfilePts] = useState([]);
  const [coords, setCoords] = useState(null);
  const [metaOpen, setMetaOpen] = useState(false);
  const [showMinimap, setShowMinimap] = useState(false);

  // Safe container list reference
  const safeContainers = Array.isArray(containers) ? containers : [];

  // Current active container object
  const activeContainer = safeContainers.find(c => c.id === activeContainerId) || (safeContainers.length > 0 ? safeContainers[0] : null);

  // Datasets belonging to current active container
  const containerDatasets = Array.isArray(datasets) && activeContainer
    ? datasets.filter(d => (activeContainer?.datasetIds || []).includes(d.id))
    : [];

  // Initial load of backend datasets and sync with containers
  useEffect(() => {
    api.get('/datasets')
      .then(r => {
        const dsList = Array.isArray(r.data) ? r.data : [];
        setDatasets(dsList);

        setContainers(prevContainers => {
          let updated = Array.isArray(prevContainers) ? [...prevContainers] : [];
          if (updated.length === 0) {
            updated = [{ id: 'container-1', name: 'Container 1', datasetIds: [], history: {} }];
            setActiveContainerId('container-1');
          }
          const validIds = new Set(dsList.map(d => d.id));
          return updated.map(c => ({
            ...c,
            datasetIds: (c.datasetIds || []).filter(id => validIds.has(id))
          }));
        });
      })
      .catch(() => {});
  }, []);

  // Save containers and active container to localStorage
  useEffect(() => {
    try {
      localStorage.setItem('geotiff_containers', JSON.stringify(safeContainers));
      if (activeContainerId) {
        localStorage.setItem('geotiff_active_container', activeContainerId);
      } else {
        localStorage.removeItem('geotiff_active_container');
      }
    } catch (e) {}
  }, [containers, activeContainerId]);

  // Active container ID ref to keep event handlers synchronized
  const activeContainerIdRef = useRef(activeContainerId);
  useEffect(() => {
    activeContainerIdRef.current = activeContainerId;
  }, [activeContainerId]);

  // Sync active dataset when container dataset list updates or active container changes
  useEffect(() => {
    if (activeContainer && activeContainer.history && activeContainer.history.activeId) {
      const found = containerDatasets.find(d => d.id === activeContainer.history.activeId);
      if (found && active?.id !== found.id) {
        setActive(found);
        return;
      }
    }
    if (containerDatasets.length > 0) {
      if (!active || !containerDatasets.some(d => d.id === active.id)) {
        setActive(containerDatasets[0]);
      }
    } else {
      setActive(null);
    }
  }, [activeContainerId, datasets]);

  // Continuously persist current workspace history into active container
  useEffect(() => {
    if (!activeContainerId) return;

    let viewportData = null;
    if (osdRef.current && osdRef.current.viewport) {
      try {
        viewportData = {
          zoom: osdRef.current.viewport.getZoom(),
          center: osdRef.current.viewport.getCenter()
        };
      } catch (e) {}
    }

    const currentHistory = {
      activeId: active?.id || null,
      bands,
      mode,
      analysis,
      histBand,
      scatterBands,
      profilePts,
      ...(viewportData ? { viewport: viewportData } : (activeContainer?.history?.viewport ? { viewport: activeContainer.history.viewport } : {}))
    };

    setContainers(prev => (Array.isArray(prev) ? prev : []).map(c => {
      if (c.id === activeContainerId) {
        if (JSON.stringify(c.history) === JSON.stringify(currentHistory)) return c;
        return { ...c, history: currentHistory };
      }
      return c;
    }));
  }, [activeContainerId, active?.id, bands, mode, analysis, histBand, scatterBands, profilePts]);

  // Save state snapshot of current container history
  const saveCurrentContainerHistory = () => {
    if (!activeContainerId) return;

    let viewportData = null;
    if (osdRef.current && osdRef.current.viewport) {
      try {
        viewportData = {
          zoom: osdRef.current.viewport.getZoom(),
          center: osdRef.current.viewport.getCenter()
        };
      } catch (e) {}
    }

    const currentHistory = {
      activeId: active?.id || null,
      bands,
      mode,
      analysis,
      histBand,
      scatterBands,
      profilePts,
      ...(viewportData ? { viewport: viewportData } : (activeContainer?.history?.viewport ? { viewport: activeContainer.history.viewport } : {}))
    };

    setContainers(prev => (Array.isArray(prev) ? prev : safeContainers).map(c => {
      if (c.id === activeContainerId) {
        return { ...c, history: currentHistory };
      }
      return c;
    }));
  };

  // Switch to a target container restoring its history state
  const handleSwitchContainer = (targetId) => {
    if (targetId === activeContainerId) return;
    saveCurrentContainerHistory();

    const targetContainer = safeContainers.find(c => c.id === targetId);
    if (!targetContainer) return;

    setActiveContainerId(targetId);

    const hist = targetContainer.history || {};
    if (hist.bands) setBands(hist.bands);
    if (hist.mode) setMode(hist.mode);
    if (hist.analysis) setAnalysis(hist.analysis);
    if (hist.histBand) setHistBand(hist.histBand);
    if (hist.scatterBands) setScatterBands(hist.scatterBands);
    if (hist.profilePts) setProfilePts(hist.profilePts);

    const targetDatasets = (Array.isArray(datasets) ? datasets : []).filter(d => (targetContainer.datasetIds || []).includes(d.id));
    const targetActive = targetDatasets.find(d => d.id === hist.activeId) || targetDatasets[0] || null;

    if (targetActive && active && targetActive.id === active.id && osdRef.current && osdRef.current.viewport && hist.viewport) {
      try {
        if (hist.viewport.zoom) osdRef.current.viewport.zoomTo(hist.viewport.zoom, null, true);
        if (hist.viewport.center) osdRef.current.viewport.panTo(hist.viewport.center, true);
      } catch (e) {}
    }

    setActive(targetActive);
    setStatus(`Switched to ${targetContainer.name}`);
  };

  const createNewContainer = () => {
    saveCurrentContainerHistory();
    const nextNum = safeContainers.length + 1;
    const newC = {
      id: `container-${Date.now()}`,
      name: `Container ${nextNum}`,
      datasetIds: [],
      history: {}
    };
    setContainers(prev => [...(Array.isArray(prev) ? prev : safeContainers), newC]);
    setActiveContainerId(newC.id);
    setActive(null);
    setStatus(`Created & switched to ${newC.name}`);
  };

  const deleteContainer = (e, containerId) => {
    e.stopPropagation();
    if (safeContainers.length <= 1) return;
    const remaining = safeContainers.filter(c => c.id !== containerId);
    setContainers(remaining);
    if (activeContainerId === containerId) {
      handleSwitchContainer(remaining[0].id);
    }
  };

  // OpenSeadragon initialization & view state restoration
  useEffect(() => {
    if (!viewerRef.current || !active) return;
    if (osdRef.current) {
      try { osdRef.current.destroy(); } catch (e) {}
      osdRef.current = null;
    }
    if (viewerRef.current) {
      viewerRef.current.innerHTML = '';
    }
    const max = active.max_zoom_level || 10;
    const tileUrl = (level, x, y) => `/api/tile/${active.id}/${level}/${x}/${y}.png?bands=${bands.join(',')}`;
    const source = { width: active.width, height: active.height, tileSize: 512, minLevel: 0, maxLevel: max, getTileUrl: tileUrl, ajaxWithCredentials: false };
    
    let v;
    try {
      v = OpenSeadragon({
        element: viewerRef.current,
        prefixUrl: 'https://openseadragon.github.io/openseadragon/images/',
        tileSources: source,
        showNavigator: true,
        navigatorPosition: 'BOTTOM_RIGHT',
        navigatorSizeRatio: .19,
        showNavigationControl: false,
        visibilityRatio: .95,
        constrainDuringPan: true,
        animationTime: .25,
        blendTime: 0,
        maxZoomPixelRatio: 2.5,
        immediateRender: true,
        subPixelRoundingForTilePositions: true
      });
      if (v.navigator && v.navigator.element) {
        v.navigator.element.style.display = showMinimap ? 'block' : 'none';
      }
      osdRef.current = v;
    } catch (e) {
      console.error("OpenSeadragon init error:", e);
      return;
    }

    v.addHandler('open', () => {
      setStatus('Raster ready · high-resolution tiles load on demand');
      const hist = activeContainer?.history;
      if (hist && hist.viewport && hist.activeId === active.id) {
        try {
          if (hist.viewport.zoom) v.viewport.zoomTo(hist.viewport.zoom, null, true);
          if (hist.viewport.center) v.viewport.panTo(hist.viewport.center, true);
        } catch (e) {}
      }
    });

    const saveViewportPosition = () => {
      if (!v || !v.viewport || !activeContainerIdRef.current) return;
      try {
        const zoom = v.viewport.getZoom();
        const center = v.viewport.getCenter();
        if (zoom && center) {
          setContainers(prev => (Array.isArray(prev) ? prev : []).map(c => {
            if (c.id === activeContainerIdRef.current) {
              const existing = c.history || {};
              return { ...c, history: { ...existing, viewport: { zoom, center } } };
            }
            return c;
          }));
        }
      } catch (e) {}
    };

    v.addHandler('animation-finish', saveViewportPosition);
    v.addHandler('pan', saveViewportPosition);
    v.addHandler('zoom', saveViewportPosition);

    v.addHandler('tile-load-failed', () => setStatus('A tile failed to load; retry by zooming/panning'));

    const tracker = new OpenSeadragon.MouseTracker({
      element: viewerRef.current,
      moveHandler: e => {
        if (!v.viewport) return;
        const ip = v.viewport.viewportToImageCoordinates(v.viewport.pointFromPixel(e.position));
        setCoords({ x: ip.x, y: ip.y });
      },
      clickHandler: e => {
        if (!profileMode || !v.viewport) return;
        const p = v.viewport.viewportToImageCoordinates(v.viewport.pointFromPixel(e.position));
        setProfilePts(prev => {
          const n = [...prev, p];
          if (n.length === 2) {
            runProfile(n);
            return [];
          }
          return n;
        });
      }
    });
    tracker.setTracking(true);

    return () => {
      try { tracker.destroy(); } catch (e) {}
      try { v.destroy(); } catch (e) {}
      osdRef.current = null;
      if (viewerRef.current) {
        viewerRef.current.innerHTML = '';
      }
    };
  }, [active, bands, profileMode]);

  useEffect(() => {
    if (osdRef.current && osdRef.current.navigator && osdRef.current.navigator.element) {
      osdRef.current.navigator.element.style.display = showMinimap ? 'block' : 'none';
    }
  }, [showMinimap]);

  const swipeCompareDataset = datasets.find(d => d.id === swipeCompareId) || containerDatasets.find(d => d.id !== active?.id) || datasets[0] || null;

  // Secondary OpenSeadragon viewer for Swipe Compare
  useEffect(() => {
    if (!swipeMode || !swipeViewerRef.current || !swipeCompareDataset) {
      if (osdSwipeRef.current) {
        try { osdSwipeRef.current.destroy(); } catch (e) {}
        osdSwipeRef.current = null;
      }
      return;
    }

    if (osdSwipeRef.current) {
      try { osdSwipeRef.current.destroy(); } catch (e) {}
      osdSwipeRef.current = null;
    }
    if (swipeViewerRef.current) {
      swipeViewerRef.current.innerHTML = '';
    }

    const max = swipeCompareDataset.max_zoom_level || 10;
    const tileUrl = (level, x, y) => `/api/tile/${swipeCompareDataset.id}/${level}/${x}/${y}.png?bands=${bands.join(',')}`;
    const source = { width: swipeCompareDataset.width, height: swipeCompareDataset.height, tileSize: 512, minLevel: 0, maxLevel: max, getTileUrl: tileUrl, ajaxWithCredentials: false };

    try {
      const sv = OpenSeadragon({
        element: swipeViewerRef.current,
        prefixUrl: 'https://openseadragon.github.io/openseadragon/images/',
        tileSources: source,
        showNavigator: false,
        showNavigationControl: false,
        visibilityRatio: .95,
        constrainDuringPan: true,
        animationTime: .25,
        blendTime: 0,
        maxZoomPixelRatio: 2.5,
        immediateRender: true,
        subPixelRoundingForTilePositions: true
      });
      osdSwipeRef.current = sv;

      sv.addHandler('open', () => {
        if (osdRef.current && osdRef.current.viewport) {
          try {
            sv.viewport.zoomTo(osdRef.current.viewport.getZoom(), null, true);
            sv.viewport.panTo(osdRef.current.viewport.getCenter(), true);
          } catch (e) {}
        }
      });
    } catch (e) {
      console.error("Swipe OSD init error:", e);
    }

    return () => {
      if (osdSwipeRef.current) {
        try { osdSwipeRef.current.destroy(); } catch (e) {}
        osdSwipeRef.current = null;
      }
      if (swipeViewerRef.current) {
        swipeViewerRef.current.innerHTML = '';
      }
    };
  }, [swipeMode, swipeCompareDataset, bands]);

  // Synchronize viewport navigation between primary and swipe compare viewports
  useEffect(() => {
    if (!swipeMode || !osdRef.current) return;
    const v = osdRef.current;

    const syncViewports = () => {
      if (!v.viewport || !osdSwipeRef.current || !osdSwipeRef.current.viewport) return;
      try {
        osdSwipeRef.current.viewport.zoomTo(v.viewport.getZoom(), null, true);
        osdSwipeRef.current.viewport.panTo(v.viewport.getCenter(), true);
      } catch (e) {}
    };

    v.addHandler('animation', syncViewports);
    v.addHandler('pan', syncViewports);
    v.addHandler('zoom', syncViewports);

    return () => {
      try {
        v.removeHandler('animation', syncViewports);
        v.removeHandler('pan', syncViewports);
        v.removeHandler('zoom', syncViewports);
      } catch (e) {}
    };
  }, [swipeMode, active, swipeCompareDataset]);

  const handleSwipeDragStart = (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const containerWidth = viewerWrapRef.current?.getBoundingClientRect().width || 1;
    const startPos = swipePos;

    const onMouseMove = (moveEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const deltaPercent = (deltaX / containerWidth) * 100;
      setSwipePos(clamp(startPos + deltaPercent, 0, 100));
    };

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  const runProfile = async (pts) => {
    if (!active || !chartRefs.current.profile) return;
    if (!pts || pts.length < 2) {
      try { Plotly.purge(chartRefs.current.profile); } catch (e) {}
      return;
    }
    setStatus('Sampling profile…');
    try {
      const r = await profile(active.id, { start: [pts[0].x, pts[0].y], end: [pts[1].x, pts[1].y], bands: bands.slice(0, Math.min(3, active.bands)) });
      drawProfile(r.data);
      setAnalysis('profile');
      setStatus('Profile updated');
    } catch (e) {
      setStatus('Profile failed');
      try { Plotly.purge(chartRefs.current.profile); } catch (err) {}
    }
  };

  const drawProfile = d => {
    const el = chartRefs.current.profile;
    if (!el) return;
    if (!d || !d.series) {
      try { Plotly.purge(el); } catch (e) {}
      return;
    }
    try {
      Plotly.react(el, d.series.map(s => ({ x: d.distance, y: s.values, mode: 'lines', name: `Band ${s.band}` })), {
        margin: { l: 42, r: 8, t: 8, b: 30 },
        paper_bgcolor: 'transparent',
        plot_bgcolor: 'transparent',
        font: { color: '#b9c9db', size: 10 },
        xaxis: { title: 'Distance (px)', gridcolor: '#23364b' },
        yaxis: { title: 'Value', gridcolor: '#23364b' },
        legend: { orientation: 'h', y: 1.2 },
        responsive: true
      }, { displayModeBar: false });
    } catch (e) {}
  };

  const loadHist = async () => {
    if (!chartRefs.current.hist) return;
    if (!active || active.isUploading || active.id?.startsWith('temp-')) {
      try { Plotly.purge(chartRefs.current.hist); } catch (e) {}
      return;
    }
    try {
      const r = await histogram(active.id, histBand);
      const d = r.data;
      if (!chartRefs.current.hist) return;
      Plotly.react(chartRefs.current.hist, [{ x: d.bins, y: d.counts, type: 'bar' }], {
        margin: { l: 42, r: 8, t: 8, b: 28 },
        paper_bgcolor: 'transparent',
        plot_bgcolor: 'transparent',
        font: { color: '#b9c9db', size: 10 },
        xaxis: { title: 'Pixel value', gridcolor: '#23364b' },
        yaxis: { title: 'Count', gridcolor: '#23364b' },
        bargap: .05
      }, { displayModeBar: false, responsive: true });
    } catch (e) {
      try { Plotly.purge(chartRefs.current.hist); } catch (err) {}
    }
  };

  const loadScatter = async () => {
    if (!chartRefs.current.scatter) return;
    if (!active || active.isUploading || active.id?.startsWith('temp-')) {
      try { Plotly.purge(chartRefs.current.scatter); } catch (e) {}
      return;
    }
    try {
      const r = await scatter(active.id, scatterBands[0], scatterBands[1]);
      const d = r.data;
      if (!chartRefs.current.scatter) return;
      Plotly.react(chartRefs.current.scatter, [{ x: d.x, y: d.y, mode: 'markers', type: 'scattergl', marker: { size: 2, opacity: .45 } }], {
        margin: { l: 42, r: 8, t: 8, b: 28 },
        paper_bgcolor: 'transparent',
        plot_bgcolor: 'transparent',
        font: { color: '#b9c9db', size: 10 },
        xaxis: { title: `Band ${scatterBands[0]}`, gridcolor: '#23364b' },
        yaxis: { title: `Band ${scatterBands[1]}`, gridcolor: '#23364b' }
      }, { displayModeBar: false, responsive: true });
    } catch (e) {
      try { Plotly.purge(chartRefs.current.scatter); } catch (err) {}
    }
  };

  // Clamp bands when active dataset changes
  useEffect(() => {
    if (active && !active.isUploading && !active.id?.startsWith('temp-')) {
      if (histBand > active.bands) setHistBand(1);
      if (scatterBands[0] > active.bands || scatterBands[1] > active.bands) {
        setScatterBands([1, Math.min(2, active.bands)]);
      }
      if (bands.some(b => b > active.bands)) {
        const defaultB = active.bands >= 3 ? [1, 2, 3] : [1];
        setBands(defaultB);
      }
    }
  }, [active]);

  // Update charts dynamically when active dataset, band selections, or profile points change
  useEffect(() => {
    if (!active || active.isUploading || active.id?.startsWith('temp-')) {
      if (chartRefs.current.hist) try { Plotly.purge(chartRefs.current.hist); } catch (e) {}
      if (chartRefs.current.scatter) try { Plotly.purge(chartRefs.current.scatter); } catch (e) {}
      if (chartRefs.current.profile) try { Plotly.purge(chartRefs.current.profile); } catch (e) {}
      return;
    }

    // Simultaneously load both Histogram and Scatter plot graphs
    loadHist();
    loadScatter();

    if (profilePts.length === 2) {
      runProfile(profilePts);
    } else if (chartRefs.current.profile) {
      try { Plotly.purge(chartRefs.current.profile); } catch (e) {}
    }
  }, [active, histBand, scatterBands, profilePts, activeContainerId]);

  // Step 1: File selection trigger
  const handleFileSelect = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    e.target.value = '';

    // If no containers exist yet, auto-create Container 1 and upload file into it
    if (safeContainers.length === 0) {
      uploadToContainer(null, true, f);
    } else {
      // If containers exist (2nd raster upload onwards), prompt user with Choose Storage Container modal
      setPendingFile(f);
      setShowContainerModal(true);
    }
  };

  // Step 2: Upload raster into chosen container (Separates upload from viewing)
  const uploadToContainer = async (targetContainerId, createNew = false, overrideFile = null) => {
    const fileToUpload = overrideFile || pendingFile;
    if (!fileToUpload) return;

    setShowContainerModal(false);

    // 1. Generate immediate placeholder dataset card for container list
    const tempId = `temp-${Date.now()}`;
    const tempDataset = {
      id: tempId,
      name: fileToUpload.name,
      width: '…',
      height: '…',
      bands: 3,
      isUploading: true
    };

    let targetId = targetContainerId;
    if (createNew || safeContainers.length === 0) {
      const nextNum = safeContainers.length + 1;
      const newC = {
        id: `container-${Date.now()}`,
        name: `Container ${nextNum}`,
        datasetIds: [tempId],
        history: {}
      };
      setContainers(prev => [...(Array.isArray(prev) ? prev : []), newC]);
      targetId = newC.id;
    } else {
      targetId = targetContainerId || safeContainers[0]?.id;
      setContainers(prev => (Array.isArray(prev) ? prev : []).map(c => {
        if (c.id === targetId) {
          return {
            ...c,
            datasetIds: [...(c.datasetIds || []), tempId]
          };
        }
        return c;
      }));
    }

    setActiveContainerId(targetId);
    setDatasets(prev => [...(Array.isArray(prev) ? prev : []), tempDataset]);
    setStatus(`Importing ${fileToUpload.name} into container…`);
    setPendingFile(null);

    // 2. Perform background upload without blocking UI or auto-opening viewer
    try {
      const r = await uploadRaster(fileToUpload, (pct) => {
        setStatus(`Importing ${fileToUpload.name} (${pct}%)…`);
      });
      const newDataset = r.data;

      setDatasets(prev => (Array.isArray(prev) ? prev : []).map(d => d.id === tempId ? newDataset : d));
      setContainers(prev => (Array.isArray(prev) ? prev : []).map(c => {
        if (c.id === targetId) {
          return {
            ...c,
            datasetIds: (c.datasetIds || []).map(id => id === tempId ? newDataset.id : id)
          };
        }
        return c;
      }));

      setStatus(`Imported ${newDataset.name}. Click item to open.`);
    } catch (err) {
      const is413 = err.response?.status === 413;
      const errMsg = is413
        ? 'Import failed: File is too large for web upload proxy (413 Payload Too Large). Please upload a smaller GeoTIFF sample (<30MB).'
        : (err.response?.data?.error || 'Import failed');
      setStatus(errMsg);
      setDatasets(prev => (Array.isArray(prev) ? prev : []).filter(d => d.id !== tempId));
      setContainers(prev => (Array.isArray(prev) ? prev : []).map(c => ({
        ...c,
        datasetIds: (c.datasetIds || []).filter(id => id !== tempId)
      })));
    }
  };

  const remove = async id => {
    try {
      await api.delete(`/datasets/${id}`);
      setDatasets(d => (Array.isArray(d) ? d : []).filter(x => x.id !== id));
      setContainers(prev => (Array.isArray(prev) ? prev : safeContainers).map(c => ({
        ...c,
        datasetIds: (c.datasetIds || []).filter(x => x !== id)
      })));
      if (active?.id === id) {
        setActive(null);
        if (osdRef.current) {
          try { osdRef.current.destroy(); } catch (e) {}
          osdRef.current = null;
        }
      }
    } catch {
      setStatus('Delete failed');
    }
  };

  const reset = () => osdRef.current?.viewport?.goHome?.(true);
  const fit = () => osdRef.current?.viewport?.goHome?.(true);

  const toggleMode = () => {
    if (!active) return;
    setMode(m => m === 'rgb' ? 'gray' : 'rgb');
    setBands(mode === 'rgb' ? [1] : [1, 2, 3]);
  };

  const bandOptions = active ? Array.from({ length: active.bands }, (_, i) => i + 1) : [];

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brandIcon"><GlobeIcon /></div>
          <div>
            <div className="title">GeoTIFF Studio <span>v2.0</span></div>
            <div className="subtitle">Remote Sensing Image Viewer</div>
          </div>
        </div>
        <div className="topTools">
          <button className="tool active" onClick={reset}><RotateCcw /> Reset</button>
          <button className={'tool ' + (showMinimap ? 'active' : '')} onClick={() => setShowMinimap(v => !v)}><Map /> Minimap</button>
          <button className={'tool ' + (swipeMode ? 'active' : '')} onClick={() => {
            setSwipeMode(v => !v);
            if (!swipeCompareId && containerDatasets.length > 1) {
              const other = containerDatasets.find(d => d.id !== active?.id);
              if (other) setSwipeCompareId(other.id);
            }
          }}>
            <SlidersHorizontal /> Swipe Compare
          </button>
          <button className="tool" onClick={() => setAnalysis('hist')}><BarChart3 /> Histogram</button>
          <button className="tool" onClick={() => { setProfileMode(true); setProfilePts([]); setStatus('Profile mode: click two points in the viewport'); }}><LineChart /> Profile Plot</button>
          <button className="tool" onClick={toggleMode}><ImageIcon /> {mode === 'rgb' ? 'RGB' : 'Band'}</button>
        </div>
        <div className="rgbCtl">
          <span>RGB COMPOSITE</span>
          <label>R <select value={bands[0] || 1} onChange={e => setBands([+e.target.value, bands[1] || 1, bands[2] || 1])}>{bandOptions.map(b => <option key={b}>{b}</option>)}</select></label>
          <label>G <select value={bands[1] || 1} onChange={e => setBands([bands[0] || 1, +e.target.value, bands[2] || 1])}>{bandOptions.map(b => <option key={b}>{b}</option>)}</select></label>
          <label>B <select value={bands[2] || 1} onChange={e => setBands([bands[0] || 1, bands[1] || 1, +e.target.value])}>{bandOptions.map(b => <option key={b}>{b}</option>)}</select></label>
        </div>
      </header>

      <main className="workspace">
        <aside className="sidebar">
          <button className="importBtn" onClick={() => fileRef.current?.click()}><Upload /> Import Rasters</button>
          <input ref={fileRef} type="file" accept=".tif,.tiff" hidden onChange={handleFileSelect} />

          {/* Container Headers & Dataset Lists */}
          <div className="sectionHead">
            <span>CONTAINERS ({safeContainers.length})</span>
            <button onClick={createNewContainer} title="Create new container">
              <Plus size={13} /> New Container
            </button>
          </div>

          <div className="containerHeaderList">
            {safeContainers.map(c => {
              const cDatasets = (Array.isArray(datasets) ? datasets : []).filter(d => (c.datasetIds || []).includes(d.id));
              const isActiveContainer = c.id === activeContainerId;

              return (
                <div key={c.id} className={'containerHeaderCard ' + (isActiveContainer ? 'active' : '')}>
                  <div
                    className="containerHeaderTitleRow"
                    onClick={() => handleSwitchContainer(c.id)}
                    title={`Click to switch to ${c.name}`}
                  >
                    <div className="containerHeaderLeft">
                      <Folder size={14} className="containerHeaderFolderIcon" />
                      <span>{c.name}</span>
                      <span className="containerHeaderBadge">{cDatasets.length}</span>
                    </div>
                    <div className="containerHeaderActions">
                      {safeContainers.length > 1 && (
                        <button
                          className="containerHeaderDelBtn"
                          title="Delete container"
                          onClick={(e) => deleteContainer(e, c.id)}
                        >
                          <Trash2 size={12} />
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Datasets belonging to this container */}
                  {isActiveContainer && (
                    <div className="datasetList">
                      {cDatasets.map((d) => (
                        <div
                          key={d.id}
                          className={'dataset ' + (active?.id === d.id ? 'selected' : '') + (d.isUploading ? ' uploading' : '')}
                          onClick={() => {
                            if (d.isUploading) {
                              setStatus('Raster is importing into container… please wait');
                              return;
                            }
                            setActive(d);
                            setStatus(`Opening ${d.name}…`);
                          }}
                        >
                          <div className="datasetTitle">
                            <span className="dot">{active?.id === d.id ? '●' : '○'}</span> {d.name}
                          </div>
                          <div className="datasetSub">
                            {d.isUploading ? 'Importing GeoTIFF…' : `GeoTIFF Dataset · ${d.width}×${d.height}`}
                          </div>
                          <div className="datasetFoot">
                            <span>{d.isUploading ? 'Processing' : `${d.bands} bands`}</span>
                            <span onClick={e => { e.stopPropagation(); remove(d.id); }}><X size={13} /></span>
                          </div>
                        </div>
                      ))}
                      {!cDatasets.length && (
                        <div className="empty">
                          No datasets in {c.name}. Click Import Rasters to add files.
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}

            {!safeContainers.length && (
              <div className="empty">
                No containers available. Import a GeoTIFF to create Container 1.
              </div>
            )}
          </div>
        </aside>

        <section className="center">
          <div className="rasterBar">
            <div><b>Layer:</b> {active?.name || 'No raster selected'} <span>Container: {activeContainer?.name || 'None'}</span></div>
            <div><b>Size:</b> {active ? `${active.width} × ${active.height}` : '—'} &nbsp; <b>Bands:</b> {active?.bands || '—'} &nbsp; <b>Zoom:</b> {active ? 'dynamic' : '—'}</div>
          </div>
          <div ref={viewerWrapRef} className="viewerWrap">
            <div ref={viewerRef} className="viewer">
              {!active && (
                <div className="welcome">
                  <ImageIcon size={48} />
                  <h2>Import a GeoTIFF raster</h2>
                  <p>
                    {safeContainers.length === 0
                      ? 'Import a GeoTIFF file to create Container 1 and load your dataset.'
                      : 'The low-resolution overview appears first; high-resolution tiles load only for the visible area.'}
                  </p>
                  <button onClick={() => fileRef.current?.click()}><Upload /> Import Raster</button>
                </div>
              )}
              {loading && <div className="loading">Reading raster…</div>}
              {profileMode && (
                <div className="profileHint">
                  <MousePointer2 /> Click two points for profile <button onClick={() => setProfileMode(false)}>Cancel</button>
                </div>
              )}
            </div>

            {/* Swipe Compare Secondary Viewport & Controls */}
            {swipeMode && active && (
              <>
                <div
                  ref={swipeViewerRef}
                  className="swipeViewer"
                  style={{ clipPath: `inset(0 0 0 ${swipePos}%)` }}
                />
                <div className="swipeControlBar">
                  <div className="swipeSelectGroup">
                    <span className="swipeLabel primary">Layer A (Left):</span>
                    <select value={active?.id || ''} onChange={e => { const found = datasets.find(d => d.id === e.target.value); if (found) setActive(found); }}>
                      {(containerDatasets.length > 0 ? containerDatasets : datasets).map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                    </select>
                  </div>
                  <div className="swipeDividerIcon"><SlidersHorizontal size={14} /></div>
                  <div className="swipeSelectGroup">
                    <span className="swipeLabel compare">Layer B (Right):</span>
                    <select value={swipeCompareDataset?.id || ''} onChange={e => setSwipeCompareId(e.target.value)}>
                      {(containerDatasets.length > 0 ? containerDatasets : datasets).map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                    </select>
                  </div>
                  <div className="swipeSliderWrap">
                    <span>0%</span>
                    <input type="range" min="0" max="100" value={swipePos} onChange={e => setSwipePos(+e.target.value)} />
                    <span>100%</span>
                  </div>
                  <button className="swipeCloseBtn" onClick={() => setSwipeMode(false)}><X size={14} /></button>
                </div>

                <div
                  className="swipeDividerLine"
                  style={{ left: `${swipePos}%` }}
                  onMouseDown={handleSwipeDragStart}
                >
                  <div className="swipeHandle">
                    <SlidersHorizontal size={14} />
                  </div>
                </div>
              </>
            )}
          </div>
          <div className="status">
            <span><Activity size={13} /> {status}</span>
            <span>{coords ? `Pixel X ${coords.x.toFixed(1)} · Y ${coords.y.toFixed(1)}` : 'Move over raster for coordinates'} {active?.crs && ` · ${active.crs}`}</span>
          </div>
        </section>
      </main>

      <section className="bottom">
        <Panel title="Histogram" icon={<BarChart3 />} active={analysis === 'hist'} onClick={() => setAnalysis('hist')}>
          <div className="panelControls">
            <select value={histBand} onChange={e => setHistBand(+e.target.value)}>
              {bandOptions.map(b => <option key={b} value={b}>Band {b}</option>)}
            </select>
          </div>
          <div ref={e => chartRefs.current.hist = e} className="chart" />
        </Panel>

        <Panel title="Scatter Plot" icon={<ScatterChart />} active={analysis === 'scatter'} onClick={() => setAnalysis('scatter')}>
          <div className="panelControls">
            <select value={scatterBands[0]} onChange={e => setScatterBands([+e.target.value, scatterBands[1]])}>
              {bandOptions.map(b => <option key={b} value={b}>Band {b}</option>)}
            </select>
            <select value={scatterBands[1]} onChange={e => setScatterBands([scatterBands[0], +e.target.value])}>
              {bandOptions.map(b => <option key={b} value={b}>Band {b}</option>)}
            </select>
          </div>
          <div ref={e => chartRefs.current.scatter = e} className="chart" />
        </Panel>

        <Panel title="Profile Plot" icon={<LineChart />} active={analysis === 'profile'} onClick={() => { setAnalysis('profile'); setProfileMode(true); setStatus('Click two points in the viewport'); }}>
          <div ref={e => chartRefs.current.profile = e} className="chart" />
          <div className="profileEmpty">Draw a line in the viewport to sample pixel values.</div>
        </Panel>

        <Panel title="RGB Composite" icon={<ImageIcon />}>
          <img className="rgbPreview" src={active ? `/api/preview/${active.id}.png?bands=${bands.join(',')}` : ''} onError={e => e.currentTarget.style.display = 'none'} />
          <div className="rgbLegend">R Band {bands[0] || 1}<br />G Band {bands[1] || 1}<br />B Band {bands[2] || 1}</div>
        </Panel>
      </section>

      <footer className="footer">
        <span>GeoTIFF Studio · Original-file windowed reading · No COG/pyramid copies</span>
        <button onClick={() => setMetaOpen(v => !v)}><Info /> Metadata</button>
      </footer>

      {metaOpen && active && (
        <div className="metaModal">
          <div className="metaCard">
            <div className="metaHead"><b>Raster Metadata</b><button onClick={() => setMetaOpen(false)}><X /></button></div>
            {[
              ['File', active.name],
              ['Dimensions', `${active.width} × ${active.height}`],
              ['Bands', active.bands],
              ['Data type', active.dtype],
              ['CRS', active.crs || 'Not defined'],
              ['Pixel size', active.pixel_size?.join(' × ')],
              ['NoData', active.nodata ?? 'None'],
              ['Bounds', active.bounds?.map(v => v.toFixed?.(4) ?? v).join(', ')]
            ].map(([a, b]) => (
              <div className="metaRow" key={a}><span>{a}</span><b>{String(b)}</b></div>
            ))}
          </div>
        </div>
      )}

      {/* CHOOSE STORAGE CONTAINER MODAL */}
      {showContainerModal && (
        <div className="containerModalOverlay" onClick={() => { setShowContainerModal(false); setPendingFile(null); }}>
          <div className="containerModal" onClick={e => e.stopPropagation()}>
            <h3 className="containerModalTitle">Choose Storage Container</h3>
            <p className="containerModalSubtitle">
              Select an existing container or create a new one for your files.
            </p>

            <div className="containerModalList">
              {safeContainers.map(c => {
                const count = (Array.isArray(datasets) ? datasets : []).filter(d => (c.datasetIds || []).includes(d.id)).length;
                return (
                  <button
                    key={c.id}
                    className="containerModalItem"
                    onClick={() => {
                      if (pendingFile) {
                        uploadToContainer(c.id, false);
                      } else {
                        handleSwitchContainer(c.id);
                        setShowContainerModal(false);
                      }
                    }}
                  >
                    <span className="containerFolderIcon">📁</span>
                    <span>{c.name} ({count} files)</span>
                  </button>
                );
              })}
            </div>

            <button
              className="containerModalCreateBtn"
              onClick={() => {
                if (pendingFile) {
                  uploadToContainer(null, true);
                } else {
                  const nextNum = safeContainers.length + 1;
                  const newC = {
                    id: `container-${Date.now()}`,
                    name: `Container ${nextNum}`,
                    datasetIds: [],
                    history: {}
                  };
                  setContainers(prev => [...(Array.isArray(prev) ? prev : safeContainers), newC]);
                  handleSwitchContainer(newC.id);
                  setShowContainerModal(false);
                }
              }}
            >
              <span className="containerPlusIcon"><Plus size={18} /></span>
              <span>Create New Container (Container {safeContainers.length + 1})</span>
            </button>

            <button
              className="containerModalCancelBtn"
              onClick={() => {
                setShowContainerModal(false);
                setPendingFile(null);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Panel({ title, icon, children, active, onClick }) {
  return (
    <div className={'panel ' + (active ? 'panelActive' : '')}>
      <div className="panelHead" onClick={onClick}>
        {icon}<b>{title}</b><button><X size={13} /></button>
      </div>
      {children}
    </div>
  );
}

function GlobeIcon() {
  return <div className="globe">◎</div>;
}

export default function SafeApp() {
  return (
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  );
}
