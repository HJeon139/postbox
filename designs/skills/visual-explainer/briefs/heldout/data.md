# Menu prices: do the pricier dishes sell worse

- **Idea:** Across the whole menu, the pricier dishes sell more, so price looks harmless. That’s only because mains cost the most and nearly every diner orders one. Within every course, each dish that costs more sells less: a dollar more costs a main about 5% of its orders, and a side about 17%.
- **For:** The owner of a small neighborhood restaurant who is thinking of raising prices and has last quarter’s orders for every dish.
- **Question:** Do our pricier dishes sell worse?
- **Facts** (from the run’s `dishes.csv`: 34 dishes, each with its course, its price and its orders in the last 13 weeks; computed by `make-data.mjs`, seed 20261106):
  - 10,655 orders in all; the 12 mains have 5,384 of them.
  - Over all 34 dishes, orders rise with price: about 9.7 more orders a quarter for each dollar (r = 0.70).
  - Within each course they fall: sides ($4 to $7.50) lose about 26.5 orders for each dollar (r = −0.90), desserts ($8 to $10.50) about 20.6 (r = −0.75), starters ($10 to $15) about 25.8 (r = −0.84) and mains ($21 to $31.50) about 24.1 (r = −0.84). As a share of a course’s average dish, that’s 17%, 9%, 8% and 5%.
  - The five best sellers are all mains, led by the cheapest, Gnocchi ($21, 705 orders); the priciest, Ribeye ($31.50), has 381. The five worst sellers are all sides.
  - By the mains’ own trend, $2 more on every main costs about 578 main orders a quarter (11%), and main revenue falls from about $147,760 to $141,146 (4.5%).
- **Shape:** A relationship between two quantities per item, price and orders, where a third, the course, reverses it: a scatter colored by course, with a trend within each course.
- **Must show:** every dish placed by its price and its orders; each course as its own group, sloping down; that the upward trend across the whole menu is the gap between courses, not the effect of price.
- **Traps:** a bar chart of orders per dish, a ranking of best sellers, or a single trend line over all dishes, each of which says price doesn’t hurt; averages by course, which hide the slope within each; a cause beyond the data (why diners choose a dish isn’t in the file).
