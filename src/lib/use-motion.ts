'use client';

import { useReducedMotion } from 'framer-motion';

/** Central motion policy (TD-10 §3): zero-duration when reduced motion is requested. */
export function useMotion() {
  const reduced = useReducedMotion() ?? false;
  return {
    reduced,
    d: (ms: number) => (reduced ? 0 : ms / 1000),
  };
}
