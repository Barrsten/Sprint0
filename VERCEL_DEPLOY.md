# Vercel production deployment

No dashboard Root Directory change is required.
The repository root remains the Vercel project root.

`vercel.json` runs the Vite viewer build from `viewer/` and publishes `viewer/dist`.
The viewer automatically loads the full KM model from `/models/km/model.glb` and the sidecar metadata from `/models/km/metadata.json`.

Production URL: `/`
Benchmark URL: `/?benchmark=1&cold=1`
Explicit model URL: `/?model=/models/km/model.glb`
