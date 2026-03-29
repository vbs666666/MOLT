import * as d3 from 'd3';
import React, { useCallback, useEffect, useRef } from 'react';
import { cosineSimilarity, averageEmbeddings } from '@/lib/semantic/profileEmbedding';
import type { MapNode } from '@/types';

// useStableCallback: keeps the latest callback in a ref so D3 event handlers
// can call the current version without needing to be in useEffect deps.
function useStableCallback<T extends (...args: never[]) => unknown>(fn: T): React.RefObject<T> {
  const ref = useRef<T>(fn);
  useEffect(() => {
    ref.current = fn;
  });
  return ref;
}

interface SimulationNode extends d3.SimulationNodeDatum {
  id: string;
  type?: 'lighthouse' | 'explorer';
  pathType: 'A' | 'B' | 'C';
  user_id?: string;
  direction?: string;
  city?: string;
  lightMessage?: string;
  startPoint?: string;
  turningPoint?: string;
  currentState?: string;
  visibility?: 'full' | 'partial' | 'minimal';
  profileEmbedding?: number[];
  clusterId?: string;
}

interface ForceGraphProps {
  nodes: MapNode[];
  currentUserId?: string;
  onNodeClick: (node: MapNode) => void;
}

function resolveToken(token: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  return `hsl(${value})`;
}

function supportsSvgTransformTransitions(): boolean {
  if (typeof document === 'undefined') return false;

  const group = document.createElementNS('http://www.w3.org/2000/svg', 'g') as SVGGElement & {
    transform?: { baseVal?: { consolidate?: () => unknown } };
  };

  return typeof group.transform?.baseVal?.consolidate === 'function';
}

/**
 * D3.js 力导向图组件
 * 修复：节点初始位置散开（pre-warm + 嵌套 g 动画），添加 +/- 缩放按钮
 */
export const ForceGraph: React.FC<ForceGraphProps> = ({ nodes, currentUserId, onNodeClick }) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const canAnimateTransforms = supportsSvgTransformTransitions();
  // Store zoom behavior and svg selection for button handlers
  const zoomRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const svgSelRef = useRef<d3.Selection<SVGSVGElement, unknown, null, undefined> | null>(null);
  // Stable ref: D3 click handler reads this without being a useEffect dependency.
  // This prevents the simulation from rebuilding every time onNodeClick changes.
  const onNodeClickRef = useStableCallback(onNodeClick);

  const handleZoomIn = useCallback(() => {
    if (!zoomRef.current || !svgSelRef.current) return;
    svgSelRef.current.transition().duration(250).call(zoomRef.current.scaleBy, 1.4);
  }, []);

  const handleZoomOut = useCallback(() => {
    if (!zoomRef.current || !svgSelRef.current) return;
    svgSelRef.current.transition().duration(250).call(zoomRef.current.scaleBy, 1 / 1.4);
  }, []);

  const handleZoomReset = useCallback(() => {
    if (!zoomRef.current || !svgSelRef.current) return;
    svgSelRef.current.transition().duration(400).call(zoomRef.current.transform, d3.zoomIdentity);
  }, []);

  useEffect(() => {
    if (!svgRef.current || nodes.length === 0) return;

    const primaryColor = resolveToken('--primary');
    const accentBlue = resolveToken('--accent-blue');
    const destructiveColor = resolveToken('--destructive');
    const mutedFg = resolveToken('--muted-foreground');
    const borderColor = resolveToken('--border');
    const accentYellow = resolveToken('--accent-yellow');

    const svg = d3.select(svgRef.current);
    svgSelRef.current = svg;
    const width = svgRef.current.clientWidth || 800;
    const height = svgRef.current.clientHeight || 600;

    svg.selectAll('*').remove();

    // Pre-scatter nodes so they don't all start at origin
    const simNodes: SimulationNode[] = nodes.map((n) => ({
      ...n,
      x: width / 2 + (Math.random() - 0.5) * Math.min(width, height) * 0.6,
      y: height / 2 + (Math.random() - 0.5) * Math.min(width, height) * 0.6,
    }));

    // === 语义布局：灯塔锚定 ===
    // 注意：fx/fy 必须在 simulation.tick() 之前设置
    const directions = [...new Set(simNodes.map(n => n.direction).filter(Boolean))] as string[];

    // 1. 计算每个方向的 centroid embedding（该方向所有节点 embedding 的平均）
    const directionCentroids = new Map<string, number[]>();
    directions.forEach(dir => {
      const embeddings = simNodes
        .filter(n => n.direction === dir && (n.profileEmbedding?.length ?? 0) > 0)
        .map(n => n.profileEmbedding!);
      const centroid = embeddings.length > 0 ? averageEmbeddings(embeddings) : [];
      directionCentroids.set(dir, centroid);
    });

    // 2. 最近邻排序：相似方向相邻排列，使圆上相邻位置 = 语义相近
    //    结果：相似方向 → 圆上相邻 → 空间距离近；不相似方向 → 圆上更远
    const sortedDirections = (function nearestNeighborSort(dirs: string[]): string[] {
      if (dirs.length <= 2) return dirs;
      const remaining = new Set(dirs);
      const sorted: string[] = [];
      let current = dirs[0];
      sorted.push(current);
      remaining.delete(current);
      while (remaining.size > 0) {
        const cEmbed = directionCentroids.get(current) ?? [];
        let bestDir = '';
        let bestSim = -Infinity;
        remaining.forEach(dir => {
          const dEmbed = directionCentroids.get(dir) ?? [];
          const sim = cEmbed.length > 0 && dEmbed.length > 0
            ? cosineSimilarity(cEmbed, dEmbed)
            : 0;
          if (sim > bestSim) { bestSim = sim; bestDir = dir; }
        });
        if (!bestDir) bestDir = [...remaining][0];
        sorted.push(bestDir);
        remaining.delete(bestDir);
        current = bestDir;
      }
      return sorted;
    })(directions);

    // 3. 按排序后顺序分配圆形坐标
    const lighthouseByDirection = new Map<string, SimulationNode>();
    const r = Math.min(width, height) * 0.32;

    sortedDirections.forEach((dir, i) => {
      const angle = (2 * Math.PI * i) / sortedDirections.length;
      const cx = width / 2 + r * Math.cos(angle);
      const cy = height / 2 + r * Math.sin(angle);

      const lighthousesForDir = simNodes.filter(n => n.type === 'lighthouse' && n.direction === dir);
      lighthousesForDir.forEach((lighthouse, j) => {
        if (j === 0) {
          lighthouse.fx = cx;
          lighthouse.fy = cy;
        } else {
          const subAngle = (2 * Math.PI * j) / lighthousesForDir.length;
          lighthouse.fx = cx + 50 * Math.cos(subAngle);
          lighthouse.fy = cy + 50 * Math.sin(subAngle);
        }
      });
      if (lighthousesForDir.length > 0) {
        lighthouseByDirection.set(dir, lighthousesForDir[0]);
      }
    });

    // 4. 没有 direction / 没有对应灯塔的节点：clusterId fallback
    simNodes.forEach(node => {
      if (node.type === 'lighthouse') return;
      const lh = node.direction ? lighthouseByDirection.get(node.direction) : undefined;
      if (lh?.fx != null) {
        // Pre-position regular nodes near their direction's lighthouse.
        // This dramatically improves clustering — without it, nodes start randomly
        // and the forceCluster is too weak to pull them across the full canvas.
        node.x = lh.fx + (Math.random() - 0.5) * 160;
        node.y = (lh.fy ?? height / 2) + (Math.random() - 0.5) * 160;
      } else if (!node.direction) {
        const fallback = simNodes.find(
          n => n.type === 'lighthouse' && n.clusterId && n.clusterId === node.clusterId
        );
        if (fallback?.fx != null) {
          node.x = fallback.fx + (Math.random() - 0.5) * 80;
          node.y = (fallback.fy ?? height / 2) + (Math.random() - 0.5) * 80;
        }
      }
    });

    const simulation = d3.forceSimulation<SimulationNode>(simNodes)
      .force('charge', d3.forceManyBody().strength(-200))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collision', d3.forceCollide().radius(42));

    // Pre-warm: run 100 ticks synchronously so nodes start spread out
    simulation.tick(100);
    simulation.alpha(0.3).restart();

    // === 语义布局：相似度边 ===
    const links: Array<{ source: string; target: string; distance: number }> = [];
    const SIM_THRESHOLD = 0.25;
    const MAX_DIST = 180;
    const MIN_DIST = 50;
    const MAX_LINKS_PER_NODE = 4;
    const linkCount = new Map<string, number>();

    for (let i = 0; i < simNodes.length; i++) {
      for (let j = i + 1; j < simNodes.length; j++) {
        const a = simNodes[i];
        const b = simNodes[j];
        const sameDirection = !!(a.direction && a.direction === b.direction);
        const aEmbed = a.profileEmbedding ?? [];
        const bEmbed = b.profileEmbedding ?? [];
        let sim = 0;
        if (aEmbed.length > 0 && bEmbed.length > 0) {
          sim = cosineSimilarity(aEmbed, bEmbed);
        }
        if (sameDirection || sim > SIM_THRESHOLD) {
          const ca = linkCount.get(a.id) ?? 0;
          const cb = linkCount.get(b.id) ?? 0;
          if (ca < MAX_LINKS_PER_NODE && cb < MAX_LINKS_PER_NODE) {
            const effectiveSim = Math.max(sim, sameDirection ? 0.4 : 0);
            const dist = MIN_DIST + (1 - effectiveSim) * MAX_DIST;
            links.push({ source: a.id, target: b.id, distance: dist });
            linkCount.set(a.id, ca + 1);
            linkCount.set(b.id, cb + 1);
          }
        }
      }
    }
    if (links.length > 0) {
      simulation.force(
        'link',
        d3.forceLink<SimulationNode, { source: string; target: string; distance: number }>(links)
          .id((d) => d.id)
          .distance((d) => d.distance)
          .strength(0.28),
      );
    }

    // === forceCluster：将非灯塔节点拉向所属方向的灯塔 ===
    // 这是 Approach C，与 forceLink 并用：forceLink 处理节点对之间的弹簧，
    // forceCluster 额外提供一个朝向灯塔的方向性引力，让普通节点真正"漂向"灯塔。
    simulation.force('cluster', (alpha: number) => {
      simNodes.forEach(node => {
        if (node.type === 'lighthouse') return;
        const lh = node.direction ? lighthouseByDirection.get(node.direction) : undefined;
        if (lh?.fx == null || lh.fy == null) return;
        const dx = lh.fx - (node.x ?? 0);
        const dy = lh.fy - (node.y ?? 0);
        // strength 0.12 × alpha：提供足够引力但不让节点堆叠在灯塔上
        node.vx = (node.vx ?? 0) + dx * 0.12 * alpha;
        node.vy = (node.vy ?? 0) + dy * 0.12 * alpha;
      });
    });

    const g = svg.append('g');

    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.3, 5])
      .on('zoom', (event) => {
        g.attr('transform', event.transform);
      });

    zoomRef.current = zoom;
    svg.call(zoom);

    // Outer g: position controlled by tick
    // Inner g: scale animation (independent of position — no conflict with tick)
    const nodeGroup = g.append('g')
      .selectAll<SVGGElement, SimulationNode>('g')
      .data(simNodes)
      .enter()
      .append('g')
      .attr('cursor', 'pointer')
      .attr('role', 'button')
      .attr('tabindex', '0')
      .attr('aria-label', (d: SimulationNode) =>
        `${d.direction ?? '探索中'}: ${d.lightMessage ?? ''}`.trim(),
      )
      // Position set immediately from pre-warmed coordinates
      .attr('transform', (d: SimulationNode) => `translate(${d.x ?? 0},${d.y ?? 0})`)
      .on('click', (_event, d: SimulationNode) => onNodeClickRef.current(d as MapNode))
      .on('keydown', (_event: KeyboardEvent, d: SimulationNode) => {
        if (_event.key === 'Enter' || _event.key === ' ') {
          _event.preventDefault();
          onNodeClickRef.current(d as MapNode);
        }
      });

    // Inner g for scale entrance animation — does NOT touch translate
    const innerGroup = nodeGroup.append('g')
      .attr('transform', 'scale(0)');

    // Start scale animation independently (doesn't block appending circles)
    const runPulseRings = (group: d3.Selection<SVGGElement, SimulationNode, d3.BaseType, unknown>) => {
      for (let i = 0; i < 3; i++) {
        group.append('circle')
          .attr('r', 0)
          .attr('fill', 'none')
          .attr('stroke', primaryColor)
          .attr('stroke-width', 1.5)
          .attr('opacity', 1)
          .transition()
          .delay(i * 300)
          .duration(2000)
          .attr('r', 30)
          .attr('opacity', 0)
          .remove();
      }
    };

    if (canAnimateTransforms) {
      innerGroup
        .transition()
        .duration(600)
        .ease(d3.easeBackOut.overshoot(1.2))
        .attr('transform', 'scale(1)')
        .on('end', function () {
          runPulseRings(d3.select<SVGGElement, SimulationNode>(this as SVGGElement));
        });
    } else {
      innerGroup.attr('transform', 'scale(1)');
    }

    // Circles and labels go on innerGroup (the scale-animated layer)
    const getFillColor = (d: SimulationNode): string => {
      if (d.user_id === currentUserId) return primaryColor;
      if (d.type === 'lighthouse') return accentYellow;
      if (d.pathType === 'C') return primaryColor;
      if (d.type === 'explorer' || d.pathType === 'B') return accentBlue;
      return destructiveColor;
    };

    (innerGroup as unknown as d3.Selection<SVGGElement, SimulationNode, SVGGElement, unknown>)
      .append('circle')
      .attr('r', (d: SimulationNode) => (d.type === 'lighthouse' ? 22 : 12))
      .attr('fill', (d: SimulationNode) => getFillColor(d))
      .attr('stroke', (d: SimulationNode) =>
        d.user_id === currentUserId ? primaryColor :
        d.type === 'lighthouse' ? accentYellow : borderColor,
      )
      .attr('stroke-width', (d: SimulationNode) => (d.user_id === currentUserId ? 3 : 1))
      .attr('opacity', 0.9)
      .style('filter', (d: SimulationNode) =>
        d.user_id === currentUserId ? `drop-shadow(0 0 10px ${primaryColor})` : 'none',
      )
      .on('mouseover', function (this: SVGCircleElement) {
        const node = d3.select<SVGCircleElement, SimulationNode>(this).datum();
        d3.select(this)
          .transition()
          .duration(200)
          .attr('r', node.type === 'lighthouse' ? 26 : 16)
          .attr('opacity', 1);
      })
      .on('mouseout', function (this: SVGCircleElement) {
        const node = d3.select<SVGCircleElement, SimulationNode>(this).datum();
        d3.select(this)
          .transition()
          .duration(200)
          .attr('r', node.type === 'lighthouse' ? 22 : 12)
          .attr('opacity', 0.9);
      });

    nodeGroup
      .filter((d: SimulationNode) => !!(d.type === 'lighthouse' && d.direction))
      .append('text')
      .attr('text-anchor', 'middle')
      .attr('dy', 30)
      .attr('fill', mutedFg)
      .attr('font-family', 'sans-serif')
      .attr('font-size', '11px')
      .style('pointer-events', 'none')
      .text((d: SimulationNode) => d.direction || '');

    // Tick updates outer g position only — no conflict with inner scale animation
    simulation.on('tick', () => {
      nodeGroup.attr('transform', (d: SimulationNode) => `translate(${d.x ?? 0},${d.y ?? 0})`);
    });
    // Stop simulation when it cools down to prevent unnecessary CPU usage
    // and residual jitter on subsequent renders.
    simulation.on('end', () => {
      simulation.stop();
    });

    return () => {
      simulation.stop();
    };
  }, [canAnimateTransforms, currentUserId, nodes]);

  const btnStyle: React.CSSProperties = {
    width: 36,
    height: 36,
    borderRadius: 8,
    border: '1px solid rgba(255,255,255,0.15)',
    background: 'rgba(10,10,10,0.8)',
    color: 'hsl(var(--foreground))',
    fontSize: 18,
    lineHeight: 1,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backdropFilter: 'blur(4px)',
  };

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', minHeight: '600px' }}>
      <svg
        ref={svgRef}
        style={{ width: '100%', height: '100%', touchAction: 'none', minHeight: '600px' }}
      />
      {/* Zoom controls */}
      <div style={{ position: 'absolute', bottom: 16, right: 16, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <button type="button" onClick={handleZoomIn} style={btnStyle} title="放大">＋</button>
        <button type="button" onClick={handleZoomOut} style={btnStyle} title="缩小">－</button>
        <button type="button" onClick={handleZoomReset} style={{ ...btnStyle, fontSize: 13 }} title="重置">⟲</button>
      </div>
    </div>
  );
};
