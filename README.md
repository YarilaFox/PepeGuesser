# PepeGuesser
<img width="1920" height="1080" alt="Игра ГЕСС" src="https://github.com/user-attachments/assets/0d44a33b-2fd2-486d-a52e-2bb54209ea9a" />

An independent Minecraft location-guessing game with solo rounds, duels, profiles, Discord sign-in, original map tiles, and cubemap panoramas.

This is a standalone extraction from the private `pepeguessr-lab` project. It excludes the unrelated PepeMaps viewer and website admin panel. This repository remains private for review; it has not been made public.

Design in Figma: https://www.figma.com/design/hZs9Gun9dYuosSadFUANpj/Design-PepeMaps-and-PepeGuessr?node-id=0-1&t=vAPk6Gn9ELMzfDq2-1

## Local development

Requires Node.js 20 or newer.

```sh
npm ci
npm run dev
```

Open `http://127.0.0.1:5175`. The frontend proxies game requests to the API on port `8787`. Solo play works without Discord. Duels and profiles require Discord OAuth credentials in `backend/.env` (start from `backend/.env.example`). Do not commit credentials. Run `npm test` to check assets and `npm run build` to build the frontend.

For a single-origin production server, build the frontend and run the backend from its workspace:

```sh
npm run build
cd backend
npm start
```

Set `SESSION_SECRET` to a long random value and configure `FRONTEND_ORIGIN`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, and `DISCORD_REDIRECT_URI` as needed. The backend serves the built frontend on `PORT` (default `8787`). Runtime profiles, rooms, and matches are written to ignored `backend/server/storage/` files. This file store is suitable for a single process, not horizontally scaled deployment.

If the frontend is hosted separately, set `VITE_PEPEGUESSR_API_BASE` during its build and include that frontend origin in `CORS_ORIGINS`. The API host must be reachable over HTTPS in production.

## Structure

- `frontend/src/pepeguessr-app.jsx`: game UI and panorama/map views.
- `frontend/public/maps/`: original guess-map tiles and manifests.
- `backend/lib/pepeguessr-api.js`: game endpoints, scoring, rooms, and profile logic.
- `backend/public/pepeguessr/panoramas/`: original cubemap images.
- `backend/api/auth/discord/`: Discord OAuth sign-in.
- `backend/data/pepeguessr/locations.json`: optional manually configured locations; complete panorama folders are discovered automatically.

The map tiles are copied from the verified 2D PepeMaps data set. Each enabled dimension uses its own manifest; the original game UI and panorama content are retained.

## From me
Этот проект можно сказать стал моей первой игрой, для меня он был по истине большим, апи соеденения и так далее, куча разных проблем)) Если хотите используйте, я слышал есть люди которые хотели-бы продолжить жизнь для пепегессера. Был закрыт так же из за нехватки денег на развитие.

## License and assets

Application source code is licensed under [Apache License 2.0](LICENSE). Copies and modified distributions must retain the license and relevant attribution in [NOTICE](NOTICE). See [ASSETS.md](ASSETS.md) before redistributing images, sounds, logos, or other assets; those are not automatically covered by the software license.
