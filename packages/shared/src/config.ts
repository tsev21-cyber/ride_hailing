import type { PlatformConfig } from './types';

/** Live-editable from the admin dashboard. Every number below moves real money. */
export const defaultConfig = (): PlatformConfig => ({
  products: {
    tylo_x: {
      key: 'tylo_x', name: 'Tylo X', blurb: 'Everyday rides, up to 4', seats: 4,
      baseCents: 185, perMileCents: 118, perMinuteCents: 26,
      bookingFeeCents: 249, minFareCents: 780, cancelFeeCents: 500,
    },
    tylo_black: {
      key: 'tylo_black', name: 'Tylo Black', blurb: 'Premium sedans, top-rated drivers', seats: 4,
      baseCents: 700, perMileCents: 315, perMinuteCents: 62,
      bookingFeeCents: 349, minFareCents: 1900, cancelFeeCents: 1000,
    },
    tylo_xl: {
      key: 'tylo_xl', name: 'Tylo XL', blurb: 'SUVs, up to 6', seats: 6,
      baseCents: 300, perMileCents: 190, perMinuteCents: 40,
      bookingFeeCents: 299, minFareCents: 1150, cancelFeeCents: 700,
    },
  },
  commissionPct: 0.25,
  stripe: { percent: 0.029, fixedCents: 30 },
  instantPayout: { percent: 0.015, minFeeCents: 50 },
  membership: {
    priceCents: 999,
    discountPct: 0.10,
    priorityDispatch: true,
    freeCancellation: true,
  },
  dispatch: {
    offerTimeoutSec: 14,
    maxOffersPerTrip: 8,
    initialRadiusMi: 2.5,
    radiusStepMi: 1.5,
    maxRadiusMi: 8,
    /** Hold a rider in the queue this long before admitting nobody is coming. */
    searchTimeoutSec: 90,
    arrivalGraceSec: 120,
    heartbeatTimeoutSec: 25,
  },
  surge: { enabled: true, floorRatio: 1.0, sensitivity: 0.38, maxMultiplier: 2.5 },
  airportSurchargeCents: 400,
});
