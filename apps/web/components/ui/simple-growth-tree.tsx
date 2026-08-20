"use client";

import { useRef, useEffect, useCallback } from "react";

interface Vector2D {
  x: number;
  y: number;
}

interface Branch {
  position: Vector2D;
  stw: number; // strokeWidth
  gen: number; // generation
  alive: boolean;
  age: number;
  angle: number;
  speed: Vector2D;
  index: number;
  maxlife: number;
  proba1: number;
  proba2: number;
  proba3: number;
  proba4: number;
  deviation: number;
}

interface Leaf {
  position: Vector2D;
  length: number;
  width: number;
  angle: number;
  hue: number;
  sat: number;
  bright: number;
  alpha: number;
  growth: number;
}

interface Tree {
  branches: Branch[];
  leaves: Leaf[];
  start: Vector2D;
  coeff: number;
  teinte: number; // base hue
  index: number;
  proba1: number;
  proba2: number;
  proba3: number;
  proba4: number;
}

export interface SimpleTreeProps {
  className?: string;
  showOverlay?: boolean;
  enableLeaves?: boolean;
}

export function SimpleTree({
  className,
  showOverlay = false,
  enableLeaves = true,
}: SimpleTreeProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>(undefined);
  const treeRef = useRef<Tree | null>(null);

  // Balanced constants for elegant simplicity
  const maxlife = 18; // Moderate life span

  const createVector = (x: number, y: number): Vector2D => ({ x, y });

  const random = (min?: number, max?: number): number => {
    if (min === undefined) return Math.random();
    if (max === undefined) return Math.random() * min;
    return min + Math.random() * (max - min);
  };

  const createTree = (width: number, height: number): Tree => {
    // Center positioning
    const x = width / 2;
    const y = height * 0.82;
    const start = createVector(x, y);

    const tree: Tree = {
      branches: [],
      leaves: [],
      start,
      coeff: start.y / (height - 100),
      teinte: random(20, 38), // Warm trunk base hue
      index: 0,
      proba1: random(0.75, 0.95),
      proba2: random(0.75, 0.95),
      proba3: random(0.5, 0.7),
      proba4: random(0.5, 0.7),
    };

    // Create trunk
    const trunk: Branch = {
      position: { ...start },
      stw: 26 * Math.sqrt(start.y / height),
      gen: 1,
      alive: true,
      age: 0,
      angle: 0,
      speed: createVector(0, -3.4),
      index: 0,
      maxlife: maxlife * random(0.8, 1.3),
      proba1: tree.proba1,
      proba2: tree.proba2,
      proba3: tree.proba3,
      proba4: tree.proba4,
      deviation: random(0.5, 0.8),
    };

    tree.branches.push(trunk);
    return tree;
  };

  const createBranch = (
    start: Vector2D,
    stw: number,
    angle: number,
    gen: number,
    index: number,
    tree: Tree,
  ): Branch => ({
    position: { ...start },
    stw,
    gen,
    alive: true,
    age: 0,
    angle,
    speed: createVector(0, -3.2),
    index,
    maxlife: maxlife * random(0.5, 1.0),
    proba1: tree.proba1,
    proba2: tree.proba2,
    proba3: tree.proba3,
    proba4: tree.proba4,
    deviation: random(0.5, 0.8),
  });

  const createLeaf = (pos: Vector2D, baseAngle: number): Leaf => {
    // Palette: lush emerald, spring leaf green, forest jade, and delicate gold highlights
    const isGoldAccent = Math.random() < 0.12;
    const leafHue = isGoldAccent ? random(42, 55) : random(95, 145);
    const leafSat = isGoldAccent ? random(170, 230) : random(130, 200);
    const leafBright = isGoldAccent ? random(180, 220) : random(140, 190);

    return {
      position: {
        x: pos.x + random(-4, 4),
        y: pos.y + random(-4, 4),
      },
      length: random(6, 12),
      width: random(3.5, 6.5),
      angle: baseAngle + random(-1.2, 1.2),
      hue: leafHue,
      sat: leafSat,
      bright: leafBright,
      alpha: random(0.45, 0.85),
      growth: 0.05,
    };
  };

  const hsbToRgb = (h: number, s: number, b: number, a = 1): string => {
    h = Math.max(0, Math.min(360, h)) / 360;
    s = Math.max(0, Math.min(255, s)) / 255;
    b = Math.max(0, Math.min(255, b)) / 255;

    const c = b * s;
    const x = c * (1 - Math.abs(((h * 6) % 2) - 1));
    const m = b - c;

    let r = 0,
      g = 0,
      bl = 0;

    if (0 <= h && h < 1 / 6) {
      r = c;
      g = x;
      bl = 0;
    } else if (1 / 6 <= h && h < 2 / 6) {
      r = x;
      g = c;
      bl = 0;
    } else if (2 / 6 <= h && h < 3 / 6) {
      r = 0;
      g = c;
      bl = x;
    } else if (3 / 6 <= h && h < 4 / 6) {
      r = 0;
      g = x;
      bl = c;
    } else if (4 / 6 <= h && h < 5 / 6) {
      r = x;
      g = 0;
      bl = c;
    } else if (5 / 6 <= h && h < 1) {
      r = c;
      g = 0;
      bl = x;
    }

    r = Math.round((r + m) * 255);
    g = Math.round((g + m) * 255);
    bl = Math.round((bl + m) * 255);

    return `rgba(${r}, ${g}, ${bl}, ${a})`;
  };

  const growBranch = (branch: Branch, tree: Tree) => {
    if (!branch.alive) return;

    branch.age++;

    // Death condition
    if (branch.age >= Math.floor(branch.maxlife / branch.gen) || random(1) < 0.025 * branch.gen) {
      branch.alive = false;

      const pos = createVector(branch.position.x, branch.position.y);

      // Bloom leaves when a branch terminates or is a higher generation
      if (enableLeaves && branch.gen >= 1.8) {
        const leafCount = Math.floor(random(2, 5));
        for (let i = 0; i < leafCount; i++) {
          tree.leaves.push(createLeaf(pos, branch.angle));
        }
      }

      // Selective branching
      if (branch.stw > 0.35 && branch.gen < 5.2) {
        const brs = tree.branches;

        if (random(1) < branch.proba1 / Math.pow(branch.gen, 0.88)) {
          brs.push(
            createBranch(
              pos,
              branch.stw * random(0.52, 0.76),
              branch.angle + random(0.55, 0.95) * branch.deviation,
              branch.gen + 0.22,
              branch.index,
              tree,
            ),
          );
        }

        if (random(1) < branch.proba2 / Math.pow(branch.gen, 0.88)) {
          brs.push(
            createBranch(
              pos,
              branch.stw * random(0.52, 0.76),
              branch.angle - random(0.55, 0.95) * branch.deviation,
              branch.gen + 0.22,
              branch.index,
              tree,
            ),
          );
        }

        if (branch.gen < 3.2 && random(1) < branch.proba3 / Math.pow(branch.gen, 1.05)) {
          brs.push(
            createBranch(
              pos,
              branch.stw * random(0.58, 0.8),
              branch.angle + random(0.3, 0.68) * branch.deviation,
              branch.gen + 0.16,
              branch.index,
              tree,
            ),
          );
        }

        if (branch.gen < 3.2 && random(1) < branch.proba4 / Math.pow(branch.gen, 1.05)) {
          brs.push(
            createBranch(
              pos,
              branch.stw * random(0.58, 0.8),
              branch.angle - random(0.3, 0.68) * branch.deviation,
              branch.gen + 0.16,
              branch.index,
              tree,
            ),
          );
        }
      }
    } else {
      branch.speed.x += random(-0.16, 0.16);
    }
  };

  const displayBranch = (branch: Branch, tree: Tree, ctx: CanvasRenderingContext2D) => {
    const c = tree.coeff;
    const st = tree.start;
    const x0 = branch.position.x;
    const y0 = branch.position.y;

    branch.position.x += -branch.speed.x * Math.cos(branch.angle) + branch.speed.y * Math.sin(branch.angle);
    branch.position.y += branch.speed.x * Math.sin(branch.angle) + branch.speed.y * Math.cos(branch.angle);

    // Subtle branch shadow
    const shadowColor = hsbToRgb(tree.teinte + branch.age + 10 * branch.gen, 15, 15, 0.05);
    ctx.strokeStyle = shadowColor;
    const shadowWidth = branch.stw * 1.2 - (branch.age / branch.maxlife) * (branch.stw * 0.4);
    ctx.lineWidth = Math.max(0.5, shadowWidth);

    const dis = 0.008 * Math.pow(Math.abs(st.y - y0), 1.3);

    ctx.beginPath();
    ctx.moveTo(x0 + dis, 2 * st.y - y0 + dis);
    ctx.lineTo(branch.position.x + dis, 2 * st.y - branch.position.y + dis);
    ctx.stroke();

    // Main branch
    const mainHue = tree.teinte + branch.age + 15 * branch.gen;
    const mainSat = Math.min(180, 100 * c + 15 * branch.gen);
    const mainBright = Math.min(150, 68 + 12 * branch.gen);
    const mainColor = hsbToRgb(mainHue, mainSat, mainBright, (24 * c) / 100);
    ctx.strokeStyle = mainColor;
    const mainWidth = branch.stw - (branch.age / branch.maxlife) * (branch.stw * 0.4);
    ctx.lineWidth = Math.max(0.2, mainWidth);

    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(branch.position.x, branch.position.y);
    ctx.stroke();
  };

  const displayLeaf = (leaf: Leaf, ctx: CanvasRenderingContext2D) => {
    if (leaf.growth < 1) {
      leaf.growth = Math.min(1, leaf.growth + 0.04);
    }

    const currentLen = leaf.length * leaf.growth;
    const currentWid = leaf.width * leaf.growth;
    const leafColor = hsbToRgb(leaf.hue, leaf.sat, leaf.bright, leaf.alpha * leaf.growth);

    ctx.save();
    ctx.translate(leaf.position.x, leaf.position.y);
    ctx.rotate(leaf.angle);

    ctx.beginPath();
    ctx.ellipse(0, 0, currentLen, currentWid, 0, 0, Math.PI * 2);
    ctx.fillStyle = leafColor;
    ctx.fill();

    // Delicate leaf vein
    if (currentLen > 5) {
      const veinColor = hsbToRgb(leaf.hue - 8, leaf.sat * 0.7, Math.min(255, leaf.bright + 25), leaf.alpha * 0.5);
      ctx.strokeStyle = veinColor;
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(-currentLen * 0.75, 0);
      ctx.lineTo(currentLen * 0.75, 0);
      ctx.stroke();
    }

    ctx.restore();
  };

  const setup = useCallback(() => {
    if (!canvasRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const rect = canvas.parentElement?.getBoundingClientRect();
    canvas.width = rect?.width || window.innerWidth;
    canvas.height = rect?.height || window.innerHeight;

    // Clean, elegant background
    const bgColor = hsbToRgb(42, 10, 248);
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Vignette
    const gradient = ctx.createRadialGradient(
      canvas.width / 2,
      canvas.height / 2,
      0,
      canvas.width / 2,
      canvas.height / 2,
      Math.max(canvas.width, canvas.height) * 0.85,
    );
    gradient.addColorStop(0, "rgba(0,0,0,0)");
    gradient.addColorStop(1, "rgba(13,59,38,0.03)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    treeRef.current = createTree(canvas.width, canvas.height);
  }, []);

  const draw = useCallback(() => {
    if (!canvasRef.current || !treeRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const tree = treeRef.current;
    let hasActiveElements = false;

    // Grow and display branches
    tree.branches.forEach((branch) => {
      if (branch.alive) {
        hasActiveElements = true;
        growBranch(branch, tree);
        displayBranch(branch, tree, ctx);
      }
    });

    // Grow and display blooming leaves
    tree.leaves.forEach((leaf) => {
      if (leaf.growth < 1) {
        hasActiveElements = true;
      }
      displayLeaf(leaf, ctx);
    });

    if (hasActiveElements) {
      setTimeout(() => {
        animationRef.current = requestAnimationFrame(draw);
      }, 1000 / 85);
    }
  }, [enableLeaves]);

  const handleClick = () => {
    if (animationRef.current) {
      cancelAnimationFrame(animationRef.current);
    }
    setup();
    draw();
  };

  useEffect(() => {
    setup();
    draw();

    const handleResize = () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
      setup();
      draw();
    };

    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [setup, draw]);

  return (
    <div className={`relative w-full h-full overflow-hidden ${className || ""}`}>
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full cursor-pointer"
        onClick={handleClick}
        title="Click to grow a new tree"
      />

      {showOverlay ? (
        <>
          <div className="absolute bottom-6 right-6 text-xs text-[color:var(--color-steel)] font-light pointer-events-none select-none">
            Click to grow a new tree
          </div>
          <div className="absolute top-6 left-6 text-[color:var(--color-forest)] opacity-80 pointer-events-none select-none">
            <h1 className="text-2xl font-light tracking-wider">Treelife</h1>
            <p className="text-xs font-medium opacity-75">Organic Intelligence</p>
          </div>
        </>
      ) : null}
    </div>
  );
}
