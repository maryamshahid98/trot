// The Vercel function: every /api/... request arrives here (vercel.json) and is handed to the API.
// apps/api/dist/serverless.mjs is made during the build by scripts/build-vercel-api.mjs.
import { createServerlessHandler } from '../apps/api/dist/serverless.mjs';
import { restorePath } from './_path.mjs';

let ready; // the app is started once and reused while this instance stays warm

export default async function handler(req, res) {
  req.url = restorePath(req.url);
  ready ??= createServerlessHandler().catch((e) => {
    ready = undefined; // try again on the next request
    throw e;
  });
  (await ready)(req, res);
}
