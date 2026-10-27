// The voxel mascot on an 11×8 grid (x right, y down): a 9×6 body, one-column arms and
// four two-cell legs. Ears, brows and tusks give it a face.
export type Cell = [number, number]

export const MASCOT = { skin: "#4f8f2f", shade: "#3d6f24", tusk: "#f1ead2", eyes: "#0a0d08" } as const

export const BODY: Cell[] = []
for (let x = 1; x <= 9; x++) for (let y = 0; y <= 5; y++) BODY.push([x, y])

export const ARM_LEFT: Cell[] = [
  [0, 2],
  [0, 3],
]
export const ARM_RIGHT: Cell[] = [
  [10, 2],
  [10, 3],
]
export const LEGS: Cell[][] = [1, 3, 7, 9].map((x) => [
  [x, 6],
  [x, 7],
])

/** Pointed ears: slanted wedges off the top corners of the head (world units, rotation in radians). */
export const EARS = [
  { x: -1.36, y: 0.82, tilt: -0.5 },
  { x: 1.36, y: 0.82, tilt: 0.5 },
]

export const EYES = [
  { x: 2.6, y: 2.7 },
  { x: 8.4, y: 2.7 },
]

/** A heavy brow over each eye, sloping down toward the nose. */
export const BROWS = [
  { x: 2.6, y: 1.95, tilt: -0.35 },
  { x: 8.4, y: 1.95, tilt: 0.35 },
]
