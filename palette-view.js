/* Backend-neutral palette inspector. Include every layer referenced by the
   row's X-program (even if occluded), and any layer visible in its pixels.
   Photoshop-style ordering puts the highest paint layer at the top. */
export function paletteView(frame, initialPalette, count = 64) {
  const visible = new Set(frame.row);
  const participating = new Set(visible);
  for (const edge of frame.edges ?? []) participating.add(edge.layer);
  return [...participating]
    .filter(layer => Number.isInteger(layer) && layer >= 0 && layer < count)
    .sort((a, b) => b - a)
    .map(layer => {
      const color = frame.palette[layer] ?? initialPalette[layer] ?? '#000000';
      return {
        layer,
        color,
        visible: visible.has(layer),
        overridden: color !== initialPalette[layer]
      };
    });
}
