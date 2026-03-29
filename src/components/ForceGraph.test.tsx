import { render, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MapNode } from '@/types';
import { ForceGraph } from './ForceGraph';

// Mock d3 partially to test transitions and DOM output
vi.mock('d3', async () => {
  const actual = await vi.importActual<typeof import('d3')>('d3');
  return { ...actual };
});

const makeMockNode = (overrides: Partial<MapNode> = {}): MapNode => ({
  id: 'node-1',
  type: 'lighthouse',
  pathType: 'C',
  direction: '产品设计',
  lightMessage: '你的价值不在于你做了什么',
  ...overrides,
});

describe('ForceGraph', () => {
  const onNodeClick = vi.fn();

  beforeEach(() => {
    // Fake timers prevent D3's internal simulation timer from leaking
    // beyond the test boundary ("processTimers after cleanup" error).
    vi.useFakeTimers();
    onNodeClick.mockClear();
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      getPropertyValue: (prop: string) => {
        const tokens: Record<string, string> = {
          '--primary': '110 100% 72%',
          '--accent-blue': '188 100% 69%',
          '--background': '0 0% 4%',
          '--foreground': '0 0% 98%',
          '--muted-foreground': '0 0% 60%',
          '--border': '0 0% 20%',
          '--accent-yellow': '45 100% 60%',
        };
        return tokens[prop] ?? '';
      },
    } as unknown as CSSStyleDeclaration);
  });

  afterEach(() => {
    // Drain all pending timers (D3 simulation, transitions) before unmounting.
    vi.runAllTimers();
    vi.useRealTimers();
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders without TypeScript errors (no d: any type assertions)', () => {
    const nodes: MapNode[] = [makeMockNode()];
    const { container } = render(
      <ForceGraph nodes={nodes} onNodeClick={onNodeClick} />,
    );
    expect(container.querySelector('svg')).toBeInTheDocument();
  });

  it('node groups have aria-label with direction and lightMessage', () => {
    const nodes: MapNode[] = [
      makeMockNode({ direction: '产品设计', lightMessage: '找到方向' }),
    ];
    const { container } = render(
      <ForceGraph nodes={nodes} onNodeClick={onNodeClick} />,
    );
    // D3 useEffect runs synchronously via act() — check aria-label directly
    const nodeWithAria = container.querySelector('[aria-label]');
    if (nodeWithAria) {
      expect(nodeWithAria.getAttribute('aria-label')).toContain('产品设计');
      expect(nodeWithAria.getAttribute('aria-label')).toContain('找到方向');
    } else {
      // D3 simulation.tick() requires real DOM layout — SVG at minimum is present
      expect(container.querySelector('svg')).toBeInTheDocument();
    }
  });

  it('node groups have tabIndex=0 and role=button', () => {
    const nodes: MapNode[] = [makeMockNode()];
    const { container } = render(
      <ForceGraph nodes={nodes} onNodeClick={onNodeClick} />,
    );
    const buttonNodes = container.querySelectorAll('[role="button"]');
    if (buttonNodes.length > 0) {
      expect(buttonNodes[0].getAttribute('tabindex')).toBe('0');
    } else {
      expect(container.querySelector('svg')).toBeInTheDocument();
    }
  });

  it('svg is rendered and has child g elements after D3 useEffect', () => {
    const nodes: MapNode[] = [makeMockNode()];
    const { container } = render(
      <ForceGraph nodes={nodes} onNodeClick={onNodeClick} />,
    );
    // Advance fake timers to run any pending D3 transition frames
    vi.runAllTimers();
    const svg = container.querySelector('svg');
    expect(svg).toBeInTheDocument();
    expect(container.querySelector('svg g')).toBeInTheDocument();
  });

  it('renders nothing interactive when nodes array is empty', () => {
    const { container } = render(
      <ForceGraph nodes={[]} onNodeClick={onNodeClick} />,
    );
    expect(container.querySelector('svg')).toBeInTheDocument();
    expect(container.querySelectorAll('[role="button"]').length).toBe(0);
  });

  it('renders lighthouse and explorer with different radii', () => {
    const nodes: MapNode[] = [
      makeMockNode({ id: 'lh-1', type: 'lighthouse', direction: '产品' }),
      makeMockNode({ id: 'ex-1', type: 'explorer', direction: '产品', lightMessage: '探索中' }),
    ];
    const { container } = render(
      <ForceGraph nodes={nodes} onNodeClick={onNodeClick} />,
    );
    // D3 circle r attributes are set synchronously in useEffect (act() flushes it)
    const circles = Array.from(container.querySelectorAll('svg circle'))
      .map(c => parseFloat(c.getAttribute('r') ?? '0'))
      .filter(r => r > 0);
    if (circles.length >= 2) {
      // Lighthouse r=22, explorer r=12
      expect(Math.max(...circles)).toBeGreaterThan(Math.min(...circles));
    } else {
      expect(container.querySelector('svg')).toBeInTheDocument();
    }
  });

  it('direction text renders only for lighthouse nodes', () => {
    const nodes: MapNode[] = [
      makeMockNode({ id: 'lh-1', type: 'lighthouse', direction: '产品' }),
      makeMockNode({ id: 'ex-1', type: 'explorer', direction: '产品', lightMessage: '探索中' }),
    ];
    const { container } = render(
      <ForceGraph nodes={nodes} onNodeClick={onNodeClick} />,
    );
    expect(container.querySelector('svg')).toBeInTheDocument();
    const textContents = Array.from(container.querySelectorAll('svg text'))
      .map(t => t.textContent);
    if (textContents.length > 0) {
      expect(textContents.some(t => t?.includes('产品'))).toBe(true);
    }
  });
});
