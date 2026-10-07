/**
 * Places the floating teach card near a selection or an Explain trigger.
 * The card is taken out of the editor flex layout, so these numbers are
 * viewport coordinates.
 */

export interface TeachAnchor {
  x: number;
  y: number;
  width?: number;
  height?: number;
}

export const TEACH_FLOAT_WIDTH = 360;
export const TEACH_FLOAT_HEIGHT = 420;

const GAP = 12;

export function clampTeachFloat(
  left: number,
  top: number,
  cardWidth: number,
  cardHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  margin = 8,
): { left: number; top: number } {
  const maxLeft = Math.max(margin, viewportWidth - cardWidth - margin);
  const maxTop = Math.max(margin, viewportHeight - cardHeight - margin);
  return {
    left: Math.min(Math.max(left, margin), maxLeft),
    top: Math.min(Math.max(top, margin), maxTop),
  };
}

export function placeTeachFloat(input: {
  anchor: TeachAnchor | null;
  cardWidth: number;
  cardHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  margin?: number;
}): { left: number; top: number } {
  const margin = input.margin ?? 8;
  const { anchor, cardWidth, cardHeight, viewportWidth, viewportHeight } =
    input;
  if (!anchor) {
    return clampTeachFloat(
      Math.round(viewportWidth * 0.28),
      80,
      cardWidth,
      cardHeight,
      viewportWidth,
      viewportHeight,
      margin,
    );
  }

  const width = anchor.width ?? 0;
  const height = anchor.height ?? 0;
  const right = anchor.x + width + GAP;
  const leftSide = anchor.x - cardWidth - GAP;
  const below = anchor.y + height + GAP;
  const above = anchor.y - cardHeight - GAP;

  let left = right;
  let top = anchor.y;
  if (right + cardWidth > viewportWidth - margin) {
    if (leftSide >= margin) {
      left = leftSide;
    } else if (below + cardHeight <= viewportHeight - margin) {
      left = anchor.x;
      top = below;
    } else if (above >= margin) {
      left = anchor.x;
      top = above;
    } else {
      left = anchor.x;
      top = below;
    }
  }

  return clampTeachFloat(
    left,
    top,
    cardWidth,
    cardHeight,
    viewportWidth,
    viewportHeight,
    margin,
  );
}
