// Thin bootstrapper: load .env first, then dynamically import the app so config modules evaluate after
// dotenv has populated process.env (a static import would evaluate them during the initial module pass).
import './dotenv.ts';
await import('./app.ts');
