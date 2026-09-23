import React from 'react';
import { it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ReferenceImagePicker from '../components/ReferenceImagePicker.jsx';

const RESP = { ok: true, items: [
  { id: 1, kind: 'ai_image', url: '/api/storage/ai_images/gen-1.png' },
  { id: 2, kind: 'cover', url: '/api/storage/ai_images/cover-2.png' },
  { id: 3, kind: 'script_txt', url: '' },
  { id: 4, kind: 'ai_image', url: '' },
] };

it('probe2', async () => {
  window.api = { library: { list: vi.fn().mockResolvedValue(RESP) } };
  render(<ReferenceImagePicker refs={[]} onChange={() => {}} />);
  fireEvent.click(screen.getByText('从图库选'));
  await new Promise((r) => setTimeout(r, 50));
  const cells = document.querySelectorAll('.rif__lib .ms-lib__cell');
  console.log('CELLS:', cells.length);
  fireEvent.click(cells[0]);
  fireEvent.click(cells[1]);
  await new Promise((r) => setTimeout(r, 20));
  const btn = screen.getByText(/确认/);
  console.log('CONFIRM TEXT:', btn.textContent, '| disabled:', btn.disabled);
  const sel = document.querySelectorAll('.rif__lib .ms-lib__cell.is-sel');
  console.log('SELECTED CELLS:', sel.length);
  expect(true).toBe(true);
});
