import { describe, expect, it } from 'vitest';
import { VEHICLE_MODELS, modelFor, nextModel } from './vehicles';
import { validate } from './backup';

describe('vehicle models', () => {
  it('falls back to the first model when none or an unknown one is chosen', () => {
    expect(modelFor('car', {}).id).toBe('sedan');
    expect(modelFor('car', { car: 'spaceship' }).id).toBe('sedan');
    expect(modelFor('car', { car: 'taxi' }).id).toBe('taxi');
  });

  it('cycles through every model and wraps round', () => {
    const seen: string[] = [];
    let chosen: Partial<Record<'car', string>> = {};
    for (let i = 0; i < VEHICLE_MODELS.car.length + 1; i++) {
      const m = nextModel('car', chosen);
      seen.push(m.id);
      chosen = { car: m.id };
    }
    expect(seen).toEqual(['sports', 'taxi', 'pickup', 'sedan', 'sports']);
  });

  it('keeps only known models from a backup', () => {
    const { settings } = validate({ app: 'audio-map', settings: { vehicleModels: { car: 'taxi', bicycle: 'nope', boat: 'yacht', helicopter: 3 } } });
    expect(settings.vehicleModels).toEqual({ car: 'taxi' });
  });
});
