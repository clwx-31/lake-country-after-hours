// Winkleman Air scoring rules, exercised directly on the event's logic.
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { airScore } from '../src/events/defs';
import { AirRun, Progress, type EventHost } from '../src/events/runs';
import type { Contact } from '../src/sim/Physics';
import { loadTestDistrict } from './helpers';

function setup() {
  const d = loadTestDistrict();
  const player = { x: 0, z: 0, h: 0, speed: 0 } as unknown as EventHost['player'];
  const toasts: string[] = [];
  const host = {
    d, scene: new THREE.Scene(), player, frozen: false, groundAt: (x: number, z: number) => d.terrain.height(x, z),
    cue: () => {}, toast: (b: string) => toasts.push(b), finishEvent: () => {},
  } as unknown as EventHost;
  const run = new AirRun(host);
  (run as unknown as { prog: Progress }).prog = new Progress(run.course, false, run.def.startAlong);
  run.state = 'running';
  const wait = (seconds: number) => { for (let t = 0; t < seconds; t += 1 / 60) run.time += 1 / 60; };
  return { run, wait, player, toasts };
}

describe('Winkleman Air scoring', () => {
  it('runs the length of Winkleman Road over real hills', () => {
    const { run } = setup();
    expect(run.course.length).toBeGreaterThan(2200);
  });

  it('scores longer and faster jumps higher', () => {
    expect(airScore(1.0, 30, 1)).toBeGreaterThan(airScore(0.5, 30, 1));
    expect(airScore(0.8, 40, 1)).toBeGreaterThan(airScore(0.8, 20, 1));
  });

  it('chains landings that follow each other quickly, capped at x6', () => {
    const { run, wait } = setup();
    run.onLand(0.6, 30);
    const one = run.score;
    wait(2);
    run.onLand(0.6, 30);
    expect(run.chain).toBe(2);
    expect(run.score - one).toBeCloseTo(one * 2, 0);
    for (let i = 0; i < 8; i++) { wait(1); run.onLand(0.6, 30); }
    expect(run.chain).toBe(10);
    expect(run.lastJump!.points).toBe(airScore(0.6, 30, 6));
    wait(6);
    run.onLand(0.6, 30);
    expect(run.chain).toBe(1);
  });

  it('a crash breaks the chain but keeps banked points', () => {
    const { run, wait, player } = setup();
    run.onLand(0.8, 30);
    wait(1);
    run.onLand(0.8, 30);
    const banked = run.score;
    run.onContact({ a: player, b: null, tag: 'building', impulse: 9000, dv: 5, x: 0, z: 0, nx: 1, nz: 0 } as Contact);
    expect(run.chain).toBe(0);
    run.onLand(0.8, 30);
    expect(run.chain).toBe(1);
    expect(run.score).toBeGreaterThan(banked);
  });
});
