// The runner image the Worker is deployed with: its tag, written by scripts/runner-image.sh together with the image
// reference in wrangler.jsonc. GET /api/projects/:p/jail names its runner after it, so a new image is a fresh runner.
export const RUNNER_IMAGE_TAG = 'd78c86e-1791834862';
