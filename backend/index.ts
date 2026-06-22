// Thin async bootstrapper. The order here is load-bearing: load .env, pull the live Predict deploy ids
// from the shared DB into PIPS_DEPLOYED_JSON, THEN load the app. The app is brought in via a dynamic
// import on purpose: a static import would let src/lib/sui/config.ts evaluate during the initial module
// pass (before the await below resolves), so the dynamic import is the boundary that guarantees config
// sees the hydrated ids. This is what makes a devnet redeploy self-heal: the deployer writes the fresh
// record to the DB, the deploy-watch worker restarts the container, and this reload adopts the new ids
// with no Dokploy env paste. Falls back to env/file when the DB has no record.
import './dotenv.ts';
import { hydrateDeploymentFromDB } from './src/lib/deployment-store.ts';

await hydrateDeploymentFromDB();
await import('./app.ts');
