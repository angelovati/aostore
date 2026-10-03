# AO Store

Community app store for [umbrelOS](https://umbrel.com).

## Install

1. In umbrelOS, open the **App Store**.
2. Click the **⋯** button in the top right and choose **Community App Stores**.
3. Paste `https://github.com/angelovati/aostore` and click **Add**.

## Apps

| App | Description |
|---|---|
| [F1 Replay Timing](aostore-f1replaytiming) | Watch Formula 1 sessions with real timing data, live or as replays |
| [Compras del Hogar](aostore-compras) | Compares supermarket prices and stock in Argentina and tells you where to buy each product |

## Adding an app

Each app lives in its own folder named `aostore-<app>` containing:

- `umbrel-app.yml` — app manifest (the `id` must match the folder name)
- `docker-compose.yml` — services; the `app_proxy` service points at the main container
  (`APP_HOST: aostore-<app>_<service>_1`) and its internal port
- `data/` — persistent data, mounted via `${APP_DATA_DIR}`

Pin images by version and digest, and pick a `port` that no other umbrelOS app uses.

## App source code

Apps built in this repo keep their source under `src/<app>`. The
`Compras image` workflow tests `src/compras` and publishes
`ghcr.io/angelovati/aostore-compras` for amd64 and arm64 on every push to the default branch.
After the first publish, make the package public in GitHub and pin its digest in
`aostore-compras/docker-compose.yml`.
