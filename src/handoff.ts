// Hand the trip to the phone's maps app for turn-by-turn, while this app keeps naming what is around.

const MODE: Record<string, string> = { walker: 'walking', bicycle: 'bicycling', car: 'driving' };

/** A Google Maps directions link; on phones it opens the installed maps app. Null in the helicopter, which has no roads. */
export function mapsUrl(lat: number, lon: number, vehicle: string): string | null {
  const mode = MODE[vehicle];
  return mode ? `https://www.google.com/maps/dir/?api=1&destination=${lat.toFixed(6)},${lon.toFixed(6)}&travelmode=${mode}` : null;
}
