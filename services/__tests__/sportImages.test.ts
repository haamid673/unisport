import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getSportImage, assetUrl } from '../sportImages';

const publicImages = fileURLToPath(new URL('../../public/images', import.meta.url));

describe('sport images', () => {
  it('resolves bundled images from the app base path', () => {
    const base = import.meta.env.BASE_URL;
    expect(getSportImage('badminton')).toBe(
      `${base}images/stephan-rothe-VePgmkq3hHI-unsplash.jpg`
    );
    expect(assetUrl('/images/a.jpg')).toBe(`${base}images/a.jpg`);
  });

  it('never returns a bare relative path that breaks off the root route', () => {
    for (const sport of [
      'Badminton', 'Football', 'Basketball', 'Cricket', 'Tennis', 'Padel',
      'Volleyball', 'Swimming', 'Gym', 'Yoga', 'Table Tennis', 'Unknown Sport'
    ]) {
      const url = getSportImage(sport);
      expect(url).not.toMatch(/^images\//);
      expect(url).toMatch(/^(\/|https:\/\/)/);
    }
  });

  it('is case- and whitespace-insensitive', () => {
    expect(getSportImage('  YOGA ')).toBe(getSportImage('yoga'));
  });

  it('only references bundled images that exist in public/images', () => {
    const files = new Set(readdirSync(publicImages));
    const base = import.meta.env.BASE_URL;

    for (const sport of ['badminton', 'volleyball', 'yoga', 'table tennis']) {
      const url = getSportImage(sport);
      expect(url.startsWith(`${base}images/`)).toBe(true);
      const file = url.slice(`${base}images/`.length);
      expect(files.has(file), `${file} missing from public/images`).toBe(true);
    }
    expect(existsSync(publicImages)).toBe(true);
  });
});
