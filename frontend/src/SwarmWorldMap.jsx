import { useEffect, useRef, useState, useMemo } from 'react';
import worldMapRawSvg from './assets/world-map.svg?raw';
import { countryFlag, countryName } from './countryUtils';
import { formatSpeed } from './lib';

export function SwarmWorldMap({
  peers = [],
  selectedCountry = null,
  onSelectCountry = () => {},
  selectedInterface = 'all',
}) {
  const containerRef = useRef(null);
  const [centroids, setCentroids] = useState({});
  const [hoveredCountry, setHoveredCountry] = useState(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0, width: 260 });

  const filteredPeers = useMemo(() => {
    if (selectedInterface === 'all') return peers;
    return peers.filter((p) => p.networkDevice === selectedInterface || p.networkType === selectedInterface);
  }, [peers, selectedInterface]);

  const countryPeerMap = useMemo(() => {
    const map = new Map();
    for (const p of filteredPeers) {
      const code = p.geo?.countryCode?.toLowerCase();
      if (!code || code === '??' || code === 'unknown') continue;

      if (!map.has(code)) {
        map.set(code, {
          code,
          countryCode: p.geo.countryCode,
          name: countryName(code),
          flag: countryFlag(code),
          peers: [],
          downSpeed: 0,
          upSpeed: 0,
          wifiCount: 0,
          tetherCount: 0,
          interfaces: new Map(),
          cities: new Set(),
          clients: new Set(),
        });
      }

      const item = map.get(code);
      item.peers.push(p);
      item.downSpeed += p.downloadSpeed || 0;
      item.upSpeed += p.uploadSpeed || 0;
      if (p.networkDevice === 'feth0' || p.networkType === 'cellular') {
        item.tetherCount++;
      } else if (p.networkType === 'wifi') {
        item.wifiCount++;
      }
      const iface = p.networkInterface || p.networkDevice || 'Unknown';
      item.interfaces.set(iface, (item.interfaces.get(iface) || 0) + 1);
      if (p.geo.city) item.cities.add(p.geo.city);
      if (p.client && p.client !== 'Unknown') item.clients.add(p.client);
    }
    return map;
  }, [filteredPeers]);

  useEffect(() => {
    if (!containerRef.current) return;
    const svgEl = containerRef.current.querySelector('svg');
    if (!svgEl) return;

    const computed = {};
    const elements = svgEl.querySelectorAll('path[id], g[id]');
    elements.forEach((el) => {
      const id = el.id?.toLowerCase();
      if (!id || id.startsWith('_') || id.length !== 2) return;
      try {
        const bbox = el.getBBox();
        if (bbox && bbox.width > 0 && bbox.height > 0) {
          computed[id] = {
            x: bbox.x + bbox.width / 2,
            y: bbox.y + bbox.height / 2,
          };
        }
      } catch {}
    });

    if (computed['us']) computed['us'] = { x: 235, y: 395 };
    if (computed['fr']) computed['fr'] = { x: 415, y: 395 };
    if (computed['ru']) computed['ru'] = { x: 575, y: 350 };
    if (computed['ca']) computed['ca'] = { x: 210, y: 340 };
    if (computed['no']) computed['no'] = { x: 435, y: 335 };

    setCentroids(computed);
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;
    const svgEl = containerRef.current.querySelector('svg');
    if (!svgEl) return;

    const allCountryEls = svgEl.querySelectorAll('path[id], g[id]');
    allCountryEls.forEach((el) => {
      const code = el.id?.toLowerCase();
      if (!code || code.startsWith('_') || code.length !== 2) return;

      const hasPeers = countryPeerMap.has(code);
      const isSelected = selectedCountry && selectedCountry.toLowerCase() === code;
      const isHovered = hoveredCountry && hoveredCountry.toLowerCase() === code;

      el.classList.remove('swarm-active-country', 'swarm-selected-country', 'swarm-hovered-country');

      if (isSelected) {
        el.classList.add('swarm-selected-country');
      } else if (isHovered) {
        el.classList.add('swarm-hovered-country');
      } else if (hasPeers) {
        el.classList.add('swarm-active-country');
      }
    });
  }, [countryPeerMap, selectedCountry, hoveredCountry]);

  const innerSvgMarkup = useMemo(() => {
    const start = worldMapRawSvg.indexOf('<g>');
    const end = worldMapRawSvg.lastIndexOf('</g>');
    if (start !== -1 && end > start) {
      return worldMapRawSvg.slice(start, end + 4);
    }
    return '';
  }, []);

  const handleMouseMove = (e) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (rect) {
      setMousePos({
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
        width: rect.width,
      });
    }
  };

  const hoveredData = hoveredCountry ? countryPeerMap.get(hoveredCountry.toLowerCase()) : null;

  return (
    <div
      className="swarm-map-container"
      ref={containerRef}
      onMouseMove={handleMouseMove}
      onMouseLeave={() => setHoveredCountry(null)}
    >
      <svg
        viewBox="30.767 241.591 784.077 458.627"
        className="swarm-map-svg"
        preserveAspectRatio="xMidYMid meet"
        onClick={(e) => {
          if (e.target.tagName === 'svg' || e.target.classList.contains('swarm-map-bg')) {
            onSelectCountry(null);
          }
        }}
      >
        <rect
          x="30.767"
          y="241.591"
          width="784.077"
          height="458.627"
          className="swarm-map-bg"
        />

        <g className="swarm-grid-lines" stroke="rgba(255, 255, 255, 0.03)" strokeDasharray="3 4">
          <line x1="30.767" y1="470.9" x2="814.844" y2="470.9" strokeWidth="0.7" />
          <line x1="422.8" y1="241.591" x2="422.8" y2="700.218" strokeWidth="0.7" />
        </g>

        <g
          className="swarm-continents-group"
          dangerouslySetInnerHTML={{ __html: innerSvgMarkup }}
          onClick={(e) => {
            const countryEl = e.target.closest('[id]');
            if (countryEl && countryEl.id && countryEl.id.length === 2) {
              const code = countryEl.id.toLowerCase();
              if (countryPeerMap.has(code)) {
                onSelectCountry(selectedCountry === code ? null : code);
              }
            }
          }}
          onMouseOver={(e) => {
            const countryEl = e.target.closest('[id]');
            if (countryEl && countryEl.id && countryEl.id.length === 2) {
              const code = countryEl.id.toLowerCase();
              if (countryPeerMap.has(code)) {
                setHoveredCountry(code);
              } else {
                setHoveredCountry(null);
              }
            }
          }}
        />

        <g className="swarm-pins-layer">
          {Array.from(countryPeerMap.values()).map((data) => {
            const pos = centroids[data.code];
            if (!pos) return null;

            const isSelected = selectedCountry === data.code;
            const isHovered = hoveredCountry === data.code;
            const hasTether = data.tetherCount > 0 && data.wifiCount === 0;
            const radius = Math.min(9, Math.max(4.5, 3.8 + Math.log2(data.peers.length + 1) * 1.9));
            const pinColor = hasTether ? '#57ab72' : '#5b8dee';

            return (
              <g
                key={data.code}
                transform={`translate(${pos.x}, ${pos.y})`}
                className={`swarm-pin ${isSelected ? 'is-selected' : ''} ${isHovered ? 'is-hovered' : ''}`}
                role="button"
                tabIndex={0}
                aria-label={`${data.name}: ${data.peers.length} peers`}
                aria-pressed={isSelected}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelectCountry(isSelected ? null : data.code);
                  }
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectCountry(selectedCountry === data.code ? null : data.code);
                }}
                onMouseEnter={() => setHoveredCountry(data.code)}
                style={{ cursor: 'pointer' }}
              >
                <circle
                  r={radius}
                  fill={pinColor}
                  stroke="#0b0f17"
                  strokeWidth="1.2"
                />
                {radius >= 6 && (
                  <text
                    textAnchor="middle"
                    dy="1.5"
                    fontSize="4.6"
                    fontWeight="700"
                    fill="#0b0f17"
                    fontFamily="monospace"
                  >
                    {data.peers.length}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>

      {hoveredData && (
        <div
          className="swarm-tooltip"
          style={{
            left: `${Math.max(8, Math.min(mousePos.width - 238, mousePos.x + 14))}px`,
            top: `${Math.max(16, mousePos.y - 70)}px`,
          }}
        >
          <div className="tooltip-header">
            <span className="tooltip-flag">{hoveredData.flag}</span>
            <span className="tooltip-country">{hoveredData.name}</span>
            <span className="tooltip-badge mono">{hoveredData.peers.length}</span>
          </div>

          <div className="tooltip-body">
            {hoveredData.cities.size > 0 && (
              <div className="tooltip-row">
                <span className="tooltip-label">City</span>
                <span className="tooltip-val ellipsis">
                  {Array.from(hoveredData.cities).slice(0, 2).join(', ')}
                </span>
              </div>
            )}
            <div className="tooltip-row">
              <span className="tooltip-label">Rate</span>
              <span className="tooltip-val mono">
                ↓ {formatSpeed(hoveredData.downSpeed)}
                {hoveredData.upSpeed > 0 && ` · ↑ ${formatSpeed(hoveredData.upSpeed)}`}
              </span>
            </div>
            <div className="tooltip-row">
              <span className="tooltip-label">Route</span>
              <span className="tooltip-val mono">
                {[...hoveredData.interfaces].map(([name, count]) => `${name} (${count})`).join(' · ')}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
