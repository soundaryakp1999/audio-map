import { describe, expect, it } from 'vitest';
import { VEHICLES, VEHICLE_MODELS, isMotor, modelFor, nextModel } from './vehicles';
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

  it('restores a motorbike and its model from a backup', () => {
    const { settings } = validate({ app: 'audio-map', settings: { vehicle: 'motorbike', vehicleModels: { motorbike: 'cruiser' } } });
    expect(settings.vehicle).toBe('motorbike');
    expect(modelFor('motorbike', settings.vehicleModels!).name).toBe('Cruiser');
  });
});

describe('motorbike', () => {
  it('keeps to the same roads as a car', () => {
    expect(isMotor('motorbike')).toBe(true);
    expect(isMotor('bicycle')).toBe(false);
    for (const type of ['motorway', 'residential', 'footway', 'cycleway', 'steps']) {
      expect(VEHICLES.motorbike.canUse({ type })).toBe(VEHICLES.car.canUse({ type }));
    }
  });
});
