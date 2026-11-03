export interface Example {
  id: string;
  title: string;
  filename: string;
  description: string;
  note: string;
  code: string;
}
export const examples: Example[] = [
  {
    id: 'commute',
    title: 'The daily commute',
    filename: 'there-and-back.src',
    description: 'Trace the carbon, all the way to the factor and its uncertainty.',
    note: 'IPCC 2006 factors and their published 95% intervals · illustrative petrol commute · CO₂ only',
    code: `// Tailpipe CO₂, not a full lifecycle footprint.
source ipcc = "IPCC 2006 · Vol. 2, Table 3.2.1 · motor gasoline", year 2006, url "https://www.ipcc-nggip.iges.or.jp/public/2006gl/vol2.html"
source heat = "IPCC 2006 · Vol. 2, Table 1.2 · motor gasoline", year 2006

let emission = 69300 kg/TJ @ipcc ~ 95% 67500..73000 @ipcc
let calorific = 44.3 MJ/kg @heat ~ 95% 42.5..44.8 @heat
assume density = 0.74 kg/L ~ ±0.025 kg/L assumed
assume consumption = 0.065 L/km ~ normal(12%) assumed
assume daily = 24 km ~ ±2 km assumed
assume workdays = 20

let fuel = daily * workdays * consumption
let energy = fuel * density * calorific
let carbon = (energy * emission) as kg

print "A month of commuting: {round(carbon, 2)}"
print "Petrol burned: {fuel as L}"
print "Combustion energy: {energy as MJ}"`,
  },
  {
    id: 'solar',
    title: 'Rooftop solar',
    filename: 'pays-for-itself.src',
    description: 'The answer from average inputs is not the average answer.',
    note: 'Illustrative quote and tariff · every spread here is an explicit assumption',
    code: `// Rooftop solar: years until it pays for itself.
source quote = "Example installer quote · 2026"
source tariff = "Example supplier tariff · 2026"

let cost = 7_400 £ @quote
let made = 3_990 kWh/year @quote ~ normal(10%) assumed
let price = 0.245 £/kWh @tariff ~ ±40% assumed
let exportPrice = 0.15 £/kWh @tariff ~ ±30% assumed
assume used = 1_600 kWh/year ~ ±600 assumed

let sold = made - used
let saving = (used * price + sold * exportPrice) as £/year

print "Pays for itself in: {round(cost / saving, 2)}"
print "Saving each year: {round(saving, 2)}"
print "Sold to the grid: {sold}"`,
  },
  {
    id: 'home',
    title: 'Home energy',
    filename: 'a-month-at-home.src',
    description: 'One bill. Every penny accounted for.',
    note: 'Illustrative household data · March 2026 · no live feeds',
    code: `// A little light on the electricity bill.
source bill = "Example electricity bill · March 2026", page 2
source tariff = "Example supplier tariff · March 2026"

let usage = 284 kWh @bill
let rate = 0.245 £/kWh @tariff
let daily = 0.52 £/day @tariff

assume days = 31 day

fn charge(energy, price) = energy * price
let electricity = charge(usage, rate)
let fixed = days * daily
let total = round(sum([electricity, fixed]), 2)

print "Electricity bill: {total}"
print "Electricity: {electricity}"
print "Standing charge: {fixed}"`,
  },
  {
    id: 'trip',
    title: 'Road trip',
    filename: 'the-long-way-round.src',
    description: 'Take the scenic route. Keep the receipts.',
    note: 'Illustrative journey & pump receipt · October 2026 · fuel only · consumption spread assumed',
    code: `// Bristol to the coast. The long way round.
source route = "Example route planner · round trip"
source pump = "Example petrol receipt · October 2026"

let distance = 186 mi @route
let price = 1.459 £/L @pump
assume consumption = 0.065 L/km ~ normal(15%) assumed
assume friends = 3

let kilometres = distance as km
let fuel = kilometres * consumption
let total = round(fuel * price, 2)
let each = round(total / friends, 2)

print "Fuel for the journey: {total}"
print "Per person: {each}"
print "Petrol needed: {fuel as L}"`,
  },
  {
    id: 'recipe',
    title: 'Sunday pancakes',
    filename: 'more-at-the-table.src',
    description: 'A few more people. The same good pancakes.',
    note: 'An original illustrative recipe · six people, no mental arithmetic',
    code: `// The recipe serves two. The table seats six.
source recipe = "A simple pancake recipe · serves two"

let flour = 150 g @recipe
let milk = 250 mL @recipe
let sugar = 20 g @recipe
assume original = 2
assume guests = 6

fn scale(ingredient, factor) = ingredient * factor
let factor = guests / original
let moreFlour = scale(flour, factor)
let moreMilk = scale(milk, factor)
let moreSugar = scale(sugar, factor)

print "Flour for the table: {moreFlour}"
print "Milk: {moreMilk}"
print "Sugar: {moreSugar}"`,
  },
];
