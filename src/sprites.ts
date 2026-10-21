// Top-down vehicle drawings for the visual map, facing up (north) so the map can rotate them to the heading.

import type { VehicleId } from './settings';
import type { VehicleModel } from './vehicles';

/** drawn at twice the size they show at, for sharp edges on high density screens */
export const SPRITE_RATIO = 2;

/** animation frames: a walker's stride, a helicopter's rotor; the rest stand still */
export const SPRITE_FRAMES: Record<VehicleId, number> = { walker: 4, bicycle: 1, car: 1, motorbike: 1, helicopter: 4 };

const SIZE: Record<VehicleId, [number, number]> = { walker: [26, 30], bicycle: [24, 44], car: [32, 56], motorbike: [30, 50], helicopter: [76, 76] };

const GLASS = '#4a6a80';
const TYRE = '#212121';
const SKIN = '#d7a27b';
const SHADOW = 'rgba(0,0,0,0.25)';

type Ctx = CanvasRenderingContext2D;

export function drawVehicle(vehicle: VehicleId, model: VehicleModel, frame: number, highContrast: boolean): ImageData {
  const [w, h] = SIZE[vehicle];
  const canvas = document.createElement('canvas');
  canvas.width = w * SPRITE_RATIO;
  canvas.height = h * SPRITE_RATIO;
  const c = canvas.getContext('2d')!;
  c.scale(SPRITE_RATIO, SPRITE_RATIO);
  c.translate(w / 2, h / 2);
  c.lineJoin = 'round';
  c.lineCap = 'round';
  c.strokeStyle = highContrast ? '#000' : 'rgba(0,0,0,0.7)';
  c.lineWidth = highContrast ? 2.2 : 1.2;
  ({ walker, bicycle, car, motorbike, helicopter })[vehicle](c, model, frame);
  return c.getImageData(0, 0, canvas.width, canvas.height);
}

function shape(c: Ctx, fill: string, path: () => void, stroke = true) {
  c.beginPath();
  path();
  c.fillStyle = fill;
  c.fill();
  if (stroke) c.stroke();
}

const rect = (c: Ctx, x: number, y: number, w: number, h: number, r: number) => () => c.roundRect(x, y, w, h, r);
const ellipse = (c: Ctx, x: number, y: number, rx: number, ry: number) => () => c.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);

function walker(c: Ctx, m: VehicleModel, frame: number) {
  // frames 1 and 3 put one foot forward and the other back; 0 and 2 stand with feet together
  const step = frame === 1 ? 5 : frame === 3 ? -5 : 0;
  shape(c, SHADOW, ellipse(c, 1.5, 2, 10, 6), false);
  shape(c, m.trim, ellipse(c, -4, -step, 2.5, 3.5));
  shape(c, m.trim, ellipse(c, 4, step, 2.5, 3.5));
  if (m.id === 'green') shape(c, m.trim, rect(c, -6, 2, 12, 7, 2)); // backpack
  // arms swing against the legs
  shape(c, SKIN, ellipse(c, -9.5, step * 0.6, 2.2, 2.2));
  shape(c, SKIN, ellipse(c, 9.5, -step * 0.6, 2.2, 2.2));
  shape(c, m.body, ellipse(c, 0, 0, 9, 4.5));
  shape(c, '#4e342e', ellipse(c, 0, -0.5, 4.5, 4.5));
}

function bicycle(c: Ctx, m: VehicleModel) {
  const tyre = m.id === 'mountain' ? 4.5 : m.id === 'road' ? 2.5 : 3.5;
  shape(c, SHADOW, rect(c, -3, -18, 9, 38, 4), false);
  shape(c, TYRE, rect(c, -tyre / 2, -21, tyre, 15, tyre / 2), false);
  shape(c, TYRE, rect(c, -tyre / 2, 6, tyre, 15, tyre / 2), false);
  shape(c, m.body, rect(c, -1.5, -13, 3, 24, 1.5));
  if (m.id === 'city') shape(c, m.trim, rect(c, -4.5, -22, 9, 6, 1.5)); // basket
  // handlebar, with grips in the trim colour
  c.save();
  c.beginPath();
  c.moveTo(-8, -10);
  c.lineTo(8, -10);
  c.strokeStyle = TYRE;
  c.lineWidth = 2;
  c.stroke();
  c.restore();
  shape(c, m.trim, ellipse(c, -8.5, -10, 1.8, 1.8), false);
  shape(c, m.trim, ellipse(c, 8.5, -10, 1.8, 1.8), false);
  // rider: arms reaching to the bar, shoulders, helmet
  c.save();
  c.beginPath();
  c.moveTo(-6, 1);
  c.lineTo(-7.5, -9);
  c.moveTo(6, 1);
  c.lineTo(7.5, -9);
  c.strokeStyle = SKIN;
  c.lineWidth = 2.5;
  c.stroke();
  c.restore();
  shape(c, '#37474f', ellipse(c, 0, 2, 7.5, 4));
  shape(c, m.body, ellipse(c, 0, -0.5, 4, 4.5));
}

function car(c: Ctx, m: VehicleModel) {
  const sports = m.id === 'sports';
  const pickup = m.id === 'pickup';
  const half = sports ? 12 : 13;
  shape(c, SHADOW, rect(c, -half + 2.5, -24, half * 2, 52, 8), false);
  for (const [x, y] of [[-half - 1, -19], [half - 3, -19], [-half - 1, 10], [half - 3, 10]]) shape(c, TYRE, rect(c, x, y, 4, 10, 1.5), false);
  shape(c, m.body, rect(c, -half, -26, half * 2, 52, sports ? 10 : 7));
  // windscreen and rear window
  shape(c, GLASS, () => {
    c.moveTo(-half + 2.5, -10);
    c.lineTo(half - 2.5, -10);
    c.lineTo(half - 4.5, -3);
    c.lineTo(-half + 4.5, -3);
    c.closePath();
  });
  if (pickup) {
    shape(c, m.body, rect(c, -half + 4, -3, half * 2 - 8, 8, 2));
    shape(c, GLASS, rect(c, -half + 4, 5, half * 2 - 8, 2.5, 1));
    shape(c, m.trim, rect(c, -half + 2.5, 9, half * 2 - 5, 15, 2)); // open bed
    c.beginPath();
    for (const x of [-4, 0, 4]) {
      c.moveTo(x, 11);
      c.lineTo(x, 22);
    }
    c.stroke();
  } else {
    const roofEnd = sports ? 8 : 13;
    shape(c, m.id === 'sedan' ? m.trim : m.body, rect(c, -half + 4, -3, half * 2 - 8, roofEnd + 3, 3));
    shape(c, GLASS, () => {
      c.moveTo(-half + 4.5, roofEnd);
      c.lineTo(half - 4.5, roofEnd);
      c.lineTo(half - 3, roofEnd + 5);
      c.lineTo(-half + 3, roofEnd + 5);
      c.closePath();
    });
  }
  if (sports) {
    shape(c, m.trim, rect(c, -4, -25, 2.5, 33, 1), false);
    shape(c, m.trim, rect(c, 1.5, -25, 2.5, 33, 1), false);
    shape(c, '#212121', rect(c, -half - 1, 21, half * 2 + 2, 4, 1.5)); // rear wing
  }
  if (m.id === 'taxi') {
    shape(c, m.trim, rect(c, -5, 1, 10, 4, 1)); // roof sign
    for (let i = 0; i < 6; i++) shape(c, i % 2 ? m.body : m.trim, rect(c, -half, -6 + i * 3, 2, 3, 0), false);
    for (let i = 0; i < 6; i++) shape(c, i % 2 ? m.trim : m.body, rect(c, half - 2, -6 + i * 3, 2, 3, 0), false);
  }
  shape(c, '#fff59d', rect(c, -half + 2, -26, 5, 3, 1.5));
  shape(c, '#fff59d', rect(c, half - 7, -26, 5, 3, 1.5));
  shape(c, '#d50000', rect(c, -half + 2, 23.5, 5, 2.5, 1), false);
  shape(c, '#d50000', rect(c, half - 7, 23.5, 5, 2.5, 1), false);
}

function motorbike(c: Ctx, m: VehicleModel) {
  const scooter = m.id === 'scooter';
  const cruiser = m.id === 'cruiser';
  const dirt = m.id === 'dirt';
  const tyre = dirt ? 5 : scooter ? 4.5 : cruiser ? 6 : 5.5;
  const bar = cruiser ? 12 : dirt ? 11 : scooter ? 8.5 : 7;
  shape(c, SHADOW, rect(c, -4, -20, 11, 44, 5), false);
  shape(c, TYRE, rect(c, -tyre / 2, -24, tyre, scooter ? 9 : 13, tyre / 2), false);
  shape(c, TYRE, rect(c, -tyre / 2, scooter ? 15 : 11, tyre, scooter ? 9 : 13, tyre / 2), false);
  if (dirt) {
    // knobbly tread, and a number board on the front
    c.save();
    c.strokeStyle = '#616161';
    c.lineWidth = 1;
    c.beginPath();
    for (const y of [-22, -19, -16, -13, 13, 16, 19, 22]) {
      c.moveTo(-tyre / 2, y);
      c.lineTo(tyre / 2, y);
    }
    c.stroke();
    c.restore();
  }
  if (scooter) {
    shape(c, m.trim, rect(c, -6, -17, 12, 6, 3)); // leg shield
    shape(c, m.body, rect(c, -6.5, -12, 13, 26, 5)); // floorboard and seat
  } else {
    shape(c, cruiser ? m.trim : m.body, rect(c, -3, -14, 6, 26, 3)); // frame and engine
    shape(c, m.body, ellipse(c, 0, -7, cruiser ? 5 : 4.5, cruiser ? 6.5 : 6)); // fuel tank
    if (!dirt) shape(c, m.body, rect(c, -3.5, 4, 7, 9, 3)); // tail
  }
  if (m.id === 'sport') {
    // pointed fairing round the headlight
    shape(c, m.body, () => {
      c.moveTo(-5.5, -13);
      c.lineTo(0, -21);
      c.lineTo(5.5, -13);
      c.closePath();
    });
    shape(c, GLASS, ellipse(c, 0, -15, 2.5, 2));
  }
  if (dirt) shape(c, m.trim, rect(c, -4, -21, 8, 4, 1.5));
  c.save();
  c.beginPath();
  c.moveTo(-bar, cruiser ? -11 : -13);
  c.lineTo(0, -14);
  c.lineTo(bar, cruiser ? -11 : -13);
  c.strokeStyle = cruiser ? m.trim : TYRE;
  c.lineWidth = 2;
  c.stroke();
  c.restore();
  shape(c, '#fff59d', ellipse(c, 0, scooter ? -18 : -17.5, 2, 1.2), false);
  // rider reaching for the bars, then helmet; a sport rider tucks forward
  const lean = m.id === 'sport' ? -3 : 0;
  c.save();
  c.beginPath();
  c.moveTo(-6, 3 + lean);
  c.lineTo(-bar + 1, cruiser ? -11 : -12.5);
  c.moveTo(6, 3 + lean);
  c.lineTo(bar - 1, cruiser ? -11 : -12.5);
  c.strokeStyle = '#263238';
  c.lineWidth = 3;
  c.stroke();
  c.restore();
  shape(c, '#37474f', ellipse(c, 0, 4 + lean, 7.5, 4.5));
  shape(c, m.id === 'scooter' ? m.trim : m.id === 'cruiser' ? '#5d4037' : m.body, ellipse(c, 0, 0.5 + lean, 4.5, 5));
  shape(c, GLASS, rect(c, -3, -3.5 + lean, 6, 2, 1), false); // visor
}

function helicopter(c: Ctx, m: VehicleModel, frame: number) {
  // the shadow sits off to one side, as if the helicopter were well above the ground
  shape(c, SHADOW, ellipse(c, 9, 10, 9, 15), false);
  shape(c, SHADOW, rect(c, 7, 18, 4, 24, 2), false);
  // skids
  c.save();
  c.beginPath();
  for (const x of [-11, 11]) {
    c.moveTo(x, -14);
    c.lineTo(x, 12);
  }
  c.strokeStyle = TYRE;
  c.lineWidth = 2;
  c.stroke();
  c.restore();
  // tail boom, stabiliser, tail rotor
  shape(c, m.body, rect(c, -2.5, 6, 5, 28, 2));
  shape(c, m.trim, rect(c, -8, 28, 16, 3.5, 1.5));
  shape(c, '#424242', rect(c, 3, 30, 2, 8, 1), false);
  shape(c, m.body, ellipse(c, 0, -4, 10, 17));
  shape(c, m.trim, rect(c, -9.5, 2, 19, 3.5, 0), false);
  if (m.id === 'rescue') {
    shape(c, m.trim, rect(c, -1.5, -6, 3, 9, 0), false);
    shape(c, m.trim, rect(c, -4.5, -3, 9, 3, 0), false);
  }
  shape(c, GLASS, ellipse(c, 0, -14, 7, 6));
  // rotor: four blades, turned a little more each frame; four frames make a quarter turn
  shape(c, 'rgba(0,0,0,0.08)', ellipse(c, 0, -2, 36, 36), false);
  c.save();
  c.translate(0, -2);
  c.rotate((frame * Math.PI) / 8);
  c.beginPath();
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2;
    c.moveTo(0, 0);
    c.lineTo(Math.cos(a) * 35, Math.sin(a) * 35);
  }
  c.strokeStyle = 'rgba(33,33,33,0.85)';
  c.lineWidth = 3;
  c.stroke();
  c.restore();
  shape(c, '#424242', ellipse(c, 0, -2, 3, 3));
}
