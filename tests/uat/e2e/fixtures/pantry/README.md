# Pantry

A small API for the food in a shared pantry. `npm start` serves it on port 8080, keeping the data in `data/pantry.json`.
- `GET /items` lists everything.
- `POST /items` adds an item: `{ "name": "rice", "qty": 2, "unit": "kg" }`. Needs a token.
