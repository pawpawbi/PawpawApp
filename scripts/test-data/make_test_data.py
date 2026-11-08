"""Generates test data for PawpawBI: data models of 7 to 9 tables that join together by their
keys, each with at least one table of over 10,000 rows (at --scale 1).

Models:
  retail     regions, stores, categories, products, promotions, customers, orders,
             order_items (~60k rows), returns
  saas       plans, features, accounts, users, subscriptions, invoices (~24k), payments,
             support_tickets, feature_usage (~40k)
  hr         locations, departments, job_titles, employees (with managers), salary_history,
             timesheets (~19k), leave_requests, performance_reviews
  logistics  carriers, warehouses, suppliers, products, purchase_orders, shipments (~12k),
             shipment_lines (~38k)

Each model is written to <out>/<model>/: a CSV per table (csv/), a SQLite database with primary
and foreign keys (<model>.sqlite), and optionally Parquet files (parquet/) and an Excel workbook
with a sheet per table (<model>.xlsx). A README.md lists the tables, their keys and how they
join. The same seed always gives the same data.

Run with the bundled Python: npm run test-data -- [options]
  --models retail,saas    which models (default: all)
  --scale 2               multiply row counts (default 1; 10 gives ~1.5M rows in total)
  --formats csv,sqlite,parquet,xlsx   (default csv,sqlite)
  --messy                 add real-world problems: orphan keys, duplicate rows, blanks,
                          inconsistent casing and stray spaces (about 1% of rows)
  --out test-data         where to write (default test-data/ in the repository)
  --seed 7                random seed (default 7)
"""

from __future__ import annotations

import argparse
import csv
import random
import sqlite3
import sys
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path

# --- Tables ------------------------------------------------------------------------------------

TYPES = {"int": "INTEGER", "float": "REAL", "text": "TEXT", "date": "TEXT", "datetime": "TEXT", "bool": "INTEGER"}


@dataclass
class Table:
    name: str
    columns: list[tuple[str, str]]  # (name, type: int | float | text | date | datetime | bool)
    rows: list[tuple] = field(default_factory=list)
    key: str | None = None
    # (column, other table, other column): how this table joins to another.
    joins: list[tuple[str, str, str]] = field(default_factory=list)
    about: str = ""

    def column_index(self, name: str) -> int:
        return [c for c, _ in self.columns].index(name)


# --- Random values ------------------------------------------------------------------------------

FIRST = (
    "Ana Ben Chloe Dev Ella Finn Grace Hiro Isla Jack Kai Lena Mateo Nina Omar Priya Quinn Rosa Sam "
    "Tara Umar Vera Will Xin Yara Zoe Liam Mia Noah Ava Leo Ivy Ezra Ruby Arjun Sofia Lucas Amara "
    "Oscar Hana Felix Nora Theo Leila Jonah Maya Elias Zara Kofi Ingrid"
).split()
LAST = (
    "Smith Jones Patel Nguyen Garcia Müller Rossi Kim Okafor Silva Cohen Novak Ivanova Tanaka "
    "Brown Wilson Taylor Martin Lee Walker Hall Young King Wright Lopez Hill Scott Green Adams "
    "Baker O'Brien Nelson Carter Mitchell Perez Roberts Turner Phillips Campbell Parker Evans "
    "Edwards Collins Stewart Sánchez Morris Rogers Reed Cook Morgan"
).split()
CITIES = [
    ("Auckland", "NZ"), ("Sydney", "AU"), ("Melbourne", "AU"), ("Brisbane", "AU"), ("Perth", "AU"),
    ("Wellington", "NZ"), ("Singapore", "SG"), ("London", "GB"), ("Manchester", "GB"),
    ("Dublin", "IE"), ("Toronto", "CA"), ("Vancouver", "CA"), ("New York", "US"),
    ("Chicago", "US"), ("Austin", "US"), ("Seattle", "US"), ("Berlin", "DE"), ("Paris", "FR"),
    ("Madrid", "ES"), ("Tokyo", "JP"),
]
WORDS = (
    "Alpha Apex Atlas Blue Bright Cedar Core Delta Echo Ever Fern Forge Gold Harbour Iron Jade "
    "Kite Lime Maple Nova Oak Orbit Pine Prime Quartz River Sage Silver Stone Summit Terra Vista "
    "Willow Zen"
).split()
COMPANY_ENDS = ["Ltd", "Group", "Co", "Partners", "Holdings", "Labs", "Systems", "Foods", "& Sons", "Studio"]


class Gen:
    """Random values from one seeded generator, so a seed always gives the same data."""

    def __init__(self, seed: int, messy: bool):
        self.r = random.Random(seed)
        self.messy = messy

    def pick(self, items):
        return items[self.r.randrange(len(items))]

    def name(self) -> tuple[str, str]:
        return self.pick(FIRST), self.pick(LAST)

    def email(self, first: str, last: str, n: int, domain: str = "example.com") -> str:
        clean = lambda s: "".join(ch for ch in s.lower() if ch.isascii() and ch.isalpha())
        return f"{clean(first)}.{clean(last)}{n}@{domain}"

    def company(self) -> str:
        return f"{self.pick(WORDS)} {self.pick(WORDS)} {self.pick(COMPANY_ENDS)}"

    def date_between(self, start: date, end: date, seasonal: bool = False) -> date:
        days = (end - start).days
        while True:
            d = start + timedelta(days=self.r.randrange(days + 1))
            # Busier in November and December, quieter in January and February.
            if not seasonal:
                return d
            weight = {11: 1.5, 12: 1.8, 1: 0.7, 2: 0.75}.get(d.month, 1.0)
            if self.r.random() < weight / 1.8:
                return d

    def moment(self, day: date) -> datetime:
        return datetime(day.year, day.month, day.day, self.r.randrange(7, 22), self.r.randrange(60), self.r.randrange(60))

    def money(self, low: float, high: float) -> float:
        return round(self.r.uniform(low, high), 2)

    def maybe(self, value, chance_of_none: float):
        return None if self.r.random() < chance_of_none else value


START, END = date(2022, 1, 1), date(2024, 12, 31)


def n(base: int, scale: float) -> int:
    return max(1, round(base * scale))


# --- Models -------------------------------------------------------------------------------------


def retail(g: Gen, scale: float) -> list[Table]:
    regions = Table("regions", [("region_id", "int"), ("region_name", "text"), ("manager", "text")], key="region_id",
                    about="Sales regions.")
    for i, name in enumerate(["North", "South", "East", "West", "Central", "Online"], 1):
        regions.rows.append((i, name, " ".join(g.name())))

    stores = Table("stores", [("store_id", "int"), ("store_name", "text"), ("city", "text"), ("country", "text"),
                              ("region_id", "int"), ("opened_on", "date"), ("floor_area_m2", "int")],
                   key="store_id", joins=[("region_id", "regions", "region_id")], about="Shops, each in a region.")
    for i in range(1, n(40, scale ** 0.5) + 1):
        city, country = g.pick(CITIES)
        stores.rows.append((i, f"{city} {g.pick(WORDS)}", city, country, g.r.randint(1, 6),
                            g.date_between(date(2010, 1, 1), date(2021, 12, 31)).isoformat(), g.r.randint(150, 2500)))

    categories = Table("categories", [("category_id", "int"), ("category_name", "text"), ("department", "text")],
                       key="category_id", about="Product categories, grouped into departments.")
    cats = [("Coffee", "Food"), ("Tea", "Food"), ("Snacks", "Food"), ("Bakery", "Food"), ("Dairy", "Food"),
            ("Kitchenware", "Home"), ("Bedding", "Home"), ("Lighting", "Home"), ("Garden", "Home"),
            ("Skincare", "Health"), ("Vitamins", "Health"), ("Toys", "Kids"), ("Books", "Kids"),
            ("Stationery", "Office"), ("Electronics", "Office"), ("Footwear", "Clothing"),
            ("Outerwear", "Clothing"), ("Accessories", "Clothing")]
    for i, (name, dept) in enumerate(cats, 1):
        categories.rows.append((i, name, dept))

    products = Table("products", [("product_id", "int"), ("sku", "text"), ("product_name", "text"), ("category_id", "int"),
                                  ("unit_price", "float"), ("unit_cost", "float"), ("is_active", "bool")],
                     key="product_id", joins=[("category_id", "categories", "category_id")], about="What's sold.")
    for i in range(1, n(400, scale ** 0.5) + 1):
        cat = g.r.randint(1, len(cats))
        price = g.money(2, 400)
        products.rows.append((i, f"SKU-{i:05d}", f"{g.pick(WORDS)} {cats[cat - 1][0]} {g.r.randint(1, 99)}", cat,
                              price, round(price * g.r.uniform(0.35, 0.8), 2), g.r.random() > 0.08))

    promotions = Table("promotions", [("promotion_id", "int"), ("promotion_name", "text"), ("discount_pct", "float"),
                                      ("starts_on", "date"), ("ends_on", "date")],
                       key="promotion_id", about="Discount campaigns; an order may use one.")
    for i in range(1, 31):
        s = g.date_between(START, END - timedelta(days=30))
        promotions.rows.append((i, f"{g.pick(['Spring', 'Summer', 'Autumn', 'Winter', 'Flash', 'Member'])} sale {i}",
                                g.pick([5.0, 10.0, 15.0, 20.0, 25.0]), s.isoformat(), (s + timedelta(days=g.r.randint(3, 30))).isoformat()))

    customers = Table("customers", [("customer_id", "int"), ("first_name", "text"), ("last_name", "text"), ("email", "text"),
                                    ("city", "text"), ("country", "text"), ("joined_on", "date"), ("loyalty_tier", "text")],
                      key="customer_id", about="People who buy. Some have no loyalty tier.")
    for i in range(1, n(3000, scale) + 1):
        first, last = g.name()
        city, country = g.pick(CITIES)
        customers.rows.append((i, first, last, g.email(first, last, i), city, country,
                               g.date_between(date(2018, 1, 1), END).isoformat(),
                               g.maybe(g.pick(["Bronze", "Silver", "Gold", "Platinum"]), 0.3)))

    orders = Table("orders", [("order_id", "int"), ("customer_id", "int"), ("store_id", "int"), ("promotion_id", "int"),
                              ("ordered_at", "datetime"), ("channel", "text"), ("status", "text")],
                   key="order_id",
                   joins=[("customer_id", "customers", "customer_id"), ("store_id", "stores", "store_id"),
                          ("promotion_id", "promotions", "promotion_id")],
                   about="One row per order. promotion_id is empty for most orders.")
    order_items = Table("order_items", [("order_item_id", "int"), ("order_id", "int"), ("product_id", "int"),
                                        ("quantity", "int"), ("unit_price", "float"), ("discount", "float")],
                        key="order_item_id",
                        joins=[("order_id", "orders", "order_id"), ("product_id", "products", "product_id")],
                        about="The lines of each order: the large table.")
    item_id = 0
    for i in range(1, n(20000, scale) + 1):
        day = g.date_between(START, END, seasonal=True)
        promo = g.r.randint(1, 30) if g.r.random() < 0.15 else None
        orders.rows.append((i, g.r.randint(1, len(customers.rows)), g.r.randint(1, len(stores.rows)), promo,
                            g.moment(day).isoformat(sep=" "), g.pick(["Store", "Store", "Web", "App"]),
                            g.pick(["Completed"] * 18 + ["Cancelled", "Refunded"])))
        for _ in range(g.r.choice([1, 1, 2, 3, 3, 4, 5, 6])):
            item_id += 1
            product = g.r.randint(1, len(products.rows))
            price = products.rows[product - 1][4]
            order_items.rows.append((item_id, i, product, g.r.choice([1, 1, 1, 2, 2, 3, 4]), price,
                                     round(price * 0.1, 2) if promo else 0.0))

    returns = Table("returns", [("return_id", "int"), ("order_item_id", "int"), ("returned_on", "date"),
                                ("reason", "text"), ("refund_amount", "float")],
                    key="return_id", joins=[("order_item_id", "order_items", "order_item_id")],
                    about="Returned order lines.")
    for i, item in enumerate(g.r.sample(order_items.rows, k=len(order_items.rows) // 50), 1):
        order_day = date.fromisoformat(orders.rows[item[1] - 1][4][:10])
        returns.rows.append((i, item[0], (order_day + timedelta(days=g.r.randint(1, 30))).isoformat(),
                             g.pick(["Damaged", "Wrong size", "Changed mind", "Late delivery", "Not as described"]),
                             round(item[3] * item[4] - item[5], 2)))

    return [regions, stores, categories, products, promotions, customers, orders, order_items, returns]


def saas(g: Gen, scale: float) -> list[Table]:
    plans = Table("plans", [("plan_id", "int"), ("plan_name", "text"), ("monthly_price", "float"), ("seats_included", "int")],
                  key="plan_id", about="Price plans.")
    for i, (name, price, seats) in enumerate([("Free", 0.0, 1), ("Starter", 29.0, 3), ("Team", 99.0, 10),
                                              ("Business", 299.0, 50), ("Enterprise", 999.0, 250)], 1):
        plans.rows.append((i, name, price, seats))

    features = Table("features", [("feature_id", "int"), ("feature_name", "text"), ("min_plan_id", "int")],
                     key="feature_id", joins=[("min_plan_id", "plans", "plan_id")],
                     about="Product features and the cheapest plan that has each.")
    names = ["Dashboards", "Exports", "Alerts", "SSO", "API access", "Audit log", "Custom roles", "Comments",
             "Scheduling", "Templates", "Sharing", "Mobile app", "Integrations", "Data retention", "Sandboxes",
             "Webhooks", "Forms", "Reports", "Imports", "Tags", "Search", "Themes", "Translations", "Backups", "Workflows"]
    for i, name in enumerate(names, 1):
        features.rows.append((i, name, g.r.randint(1, 5)))

    accounts = Table("accounts", [("account_id", "int"), ("company_name", "text"), ("industry", "text"),
                                  ("country", "text"), ("created_on", "date"), ("employee_count", "int")],
                     key="account_id", about="Customer companies.")
    for i in range(1, n(1500, scale) + 1):
        accounts.rows.append((i, g.company(), g.pick(["Retail", "Finance", "Health", "Education", "Media", "Logistics",
                                                       "Software", "Government", "Hospitality"]),
                              g.pick(CITIES)[1], g.date_between(date(2020, 1, 1), END).isoformat(),
                              g.maybe(g.r.choice([5, 12, 30, 80, 200, 750, 3000]), 0.1)))

    users = Table("users", [("user_id", "int"), ("account_id", "int"), ("email", "text"), ("role", "text"),
                            ("signed_up_at", "datetime"), ("last_seen_at", "datetime")],
                  key="user_id", joins=[("account_id", "accounts", "account_id")],
                  about="People using the product, in accounts. last_seen_at is empty for users who never came back.")
    for i in range(1, n(8000, scale) + 1):
        account = g.r.randint(1, len(accounts.rows))
        first, last = g.name()
        created = date.fromisoformat(accounts.rows[account - 1][4])
        signed = g.date_between(created, END)
        users.rows.append((i, account, g.email(first, last, i, "customer.example"), g.pick(["Owner", "Admin", "Member", "Member", "Viewer"]),
                           g.moment(signed).isoformat(sep=" "),
                           g.maybe(g.moment(g.date_between(signed, END)).isoformat(sep=" "), 0.15)))

    subscriptions = Table("subscriptions", [("subscription_id", "int"), ("account_id", "int"), ("plan_id", "int"),
                                            ("started_on", "date"), ("ended_on", "date"), ("seats", "int")],
                          key="subscription_id",
                          joins=[("account_id", "accounts", "account_id"), ("plan_id", "plans", "plan_id")],
                          about="Plans each account has had over time; ended_on is empty while it's current.")
    invoices = Table("invoices", [("invoice_id", "int"), ("subscription_id", "int"), ("issued_on", "date"),
                                  ("amount", "float"), ("currency", "text")],
                     key="invoice_id", joins=[("subscription_id", "subscriptions", "subscription_id")],
                     about="A monthly invoice per paid subscription: a large table.")
    payments = Table("payments", [("payment_id", "int"), ("invoice_id", "int"), ("paid_on", "date"),
                                  ("amount", "float"), ("method", "text")],
                     key="payment_id", joins=[("invoice_id", "invoices", "invoice_id")],
                     about="Payments of invoices; some invoices are unpaid.")
    sub_id = inv_id = pay_id = 0
    for account in range(1, len(accounts.rows) + 1):
        created = date.fromisoformat(accounts.rows[account - 1][4])
        start = created
        for _ in range(g.r.choice([1, 1, 2, 2, 3])):
            if start >= END:
                break
            sub_id += 1
            plan = g.r.choice([1, 2, 2, 3, 3, 3, 4, 5])
            length = g.r.randint(2, 30) * 30
            end = start + timedelta(days=length)
            ended = end.isoformat() if end < END else None
            seats = max(plans.rows[plan - 1][3], g.r.randint(1, 60))
            subscriptions.rows.append((sub_id, account, plan, start.isoformat(), ended, seats))
            price = plans.rows[plan - 1][2]
            month = start
            while price and month <= min(end, END):
                inv_id += 1
                amount = round(price + max(0, seats - plans.rows[plan - 1][3]) * price / 20, 2)
                invoices.rows.append((inv_id, sub_id, month.isoformat(), amount, "USD"))
                if g.r.random() < 0.93:
                    pay_id += 1
                    payments.rows.append((pay_id, inv_id, (month + timedelta(days=g.r.randint(0, 25))).isoformat(),
                                          amount, g.pick(["Card", "Card", "Card", "Bank transfer", "PayPal"])))
                month += timedelta(days=30)
            start = end + timedelta(days=g.r.randint(0, 60))

    tickets = Table("support_tickets", [("ticket_id", "int"), ("account_id", "int"), ("user_id", "int"),
                                        ("opened_at", "datetime"), ("closed_at", "datetime"), ("priority", "text"),
                                        ("category", "text"), ("satisfaction", "int")],
                    key="ticket_id",
                    joins=[("account_id", "accounts", "account_id"), ("user_id", "users", "user_id")],
                    about="Support requests. closed_at and satisfaction are empty for open tickets.")
    for i in range(1, n(6000, scale) + 1):
        user = g.pick(users.rows)
        opened = g.moment(g.date_between(START, END))
        closed = opened + timedelta(hours=g.r.randint(1, 240))
        is_open = g.r.random() < 0.06
        tickets.rows.append((i, user[1], user[0], opened.isoformat(sep=" "), None if is_open else closed.isoformat(sep=" "),
                             g.pick(["Low", "Normal", "Normal", "High", "Urgent"]),
                             g.pick(["Billing", "Bug", "How-to", "Feature request", "Access"]),
                             None if is_open else g.maybe(g.r.randint(1, 5), 0.4)))

    usage = Table("feature_usage", [("usage_id", "int"), ("user_id", "int"), ("feature_id", "int"),
                                    ("used_on", "date"), ("events", "int")],
                  key="usage_id",
                  joins=[("user_id", "users", "user_id"), ("feature_id", "features", "feature_id")],
                  about="How often each user used each feature on a day: the largest table.")
    for i in range(1, n(40000, scale) + 1):
        user = g.pick(users.rows)
        usage.rows.append((i, user[0], g.r.randint(1, len(features.rows)),
                           g.date_between(date.fromisoformat(user[4][:10]), END).isoformat(), g.r.choice([1, 1, 2, 3, 5, 8, 13, 40])))

    return [plans, features, accounts, users, subscriptions, invoices, payments, tickets, usage]


def hr(g: Gen, scale: float) -> list[Table]:
    locations = Table("locations", [("location_id", "int"), ("city", "text"), ("country", "text"), ("is_remote_hub", "bool")],
                      key="location_id", about="Offices.")
    for i, (city, country) in enumerate(g.r.sample(CITIES, 8), 1):
        locations.rows.append((i, city, country, g.r.random() < 0.25))

    departments = Table("departments", [("department_id", "int"), ("department_name", "text"), ("location_id", "int"),
                                        ("budget", "float")],
                        key="department_id", joins=[("location_id", "locations", "location_id")],
                        about="Departments, each based at a location.")
    for i, name in enumerate(["Engineering", "Sales", "Marketing", "Finance", "People", "Support", "Operations",
                              "Legal", "Product", "Design", "Data", "Security", "Facilities", "Procurement"], 1):
        departments.rows.append((i, name, g.r.randint(1, 8), float(g.r.randint(5, 120) * 50000)))

    titles = Table("job_titles", [("job_title_id", "int"), ("title", "text"), ("level", "int"),
                                  ("min_salary", "float"), ("max_salary", "float")],
                   key="job_title_id", about="Job titles and their salary bands.")
    jt = 0
    for role in ["Engineer", "Analyst", "Manager", "Specialist", "Designer", "Coordinator", "Consultant", "Lead", "Officer"]:
        for level, label in enumerate(["Junior", "", "Senior", "Principal", "Head of"], 1):
            jt += 1
            low = 45000 + level * 18000
            titles.rows.append((jt, f"{label} {role}".strip(), level, float(low), float(low + 30000)))

    employees = Table("employees", [("employee_id", "int"), ("first_name", "text"), ("last_name", "text"),
                                    ("email", "text"), ("department_id", "int"), ("job_title_id", "int"),
                                    ("manager_id", "int"), ("hired_on", "date"), ("left_on", "date"),
                                    ("employment_type", "text")],
                      key="employee_id",
                      joins=[("department_id", "departments", "department_id"),
                             ("job_title_id", "job_titles", "job_title_id"),
                             ("manager_id", "employees", "employee_id")],
                      about="Staff. manager_id is another employee (empty for the top of each department); "
                            "left_on is empty for current staff.")
    count = n(1500, scale)
    heads: dict[int, int] = {}
    for i in range(1, count + 1):
        first, last = g.name()
        dept = g.r.randint(1, len(departments.rows))
        manager = heads.get(dept)
        if manager is None:
            heads[dept] = i
        elif g.r.random() < 0.7 and i > 1:
            # Report to someone earlier in the same department, so management chains are trees.
            same = [e[0] for e in employees.rows[-200:] if e[4] == dept]
            manager = g.pick(same) if same else manager
        hired = g.date_between(date(2012, 1, 1), END)
        left = g.date_between(hired, END).isoformat() if g.r.random() < 0.18 else None
        employees.rows.append((i, first, last, g.email(first, last, i, "company.example"), dept,
                               g.r.randint(1, len(titles.rows)), manager, hired.isoformat(), left,
                               g.pick(["Full-time"] * 7 + ["Part-time", "Contractor"])))

    salary = Table("salary_history", [("salary_id", "int"), ("employee_id", "int"), ("effective_on", "date"),
                                      ("annual_salary", "float"), ("currency", "text")],
                   key="salary_id", joins=[("employee_id", "employees", "employee_id")],
                   about="Each employee's salary changes over time.")
    reviews = Table("performance_reviews", [("review_id", "int"), ("employee_id", "int"), ("reviewer_id", "int"),
                                            ("review_year", "int"), ("rating", "int"), ("promotion_recommended", "bool")],
                    key="review_id",
                    joins=[("employee_id", "employees", "employee_id"), ("reviewer_id", "employees", "employee_id")],
                    about="Yearly reviews; reviewer_id is also an employee.")
    sid = rid = 0
    for e in employees.rows:
        band = titles.rows[e[5] - 1]
        pay = g.money(band[3], band[4])
        start = date.fromisoformat(e[7])
        stop = date.fromisoformat(e[8]) if e[8] else END
        d = start
        while d <= stop:
            sid += 1
            salary.rows.append((sid, e[0], d.isoformat(), round(pay, 2), "USD"))
            pay *= g.r.uniform(1.02, 1.09)
            d += timedelta(days=365)
        for year in range(max(start.year, 2020), min(stop.year, 2024) + 1):
            rid += 1
            reviews.rows.append((rid, e[0], e[6] or e[0], year, g.r.choice([2, 3, 3, 3, 4, 4, 5]), g.r.random() < 0.15))

    timesheets = Table("timesheets", [("timesheet_id", "int"), ("employee_id", "int"), ("week_starting", "date"),
                                      ("hours", "float"), ("overtime_hours", "float"), ("project_code", "text")],
                       key="timesheet_id", joins=[("employee_id", "employees", "employee_id")],
                       about="Weekly hours: a large table.")
    for i in range(1, n(19000, scale) + 1):
        e = g.pick(employees.rows)
        start = max(date.fromisoformat(e[7]), START)
        stop = date.fromisoformat(e[8]) if e[8] else END
        if start > stop:
            start = stop
        week = g.date_between(start, stop)
        week -= timedelta(days=week.weekday())
        hours = 20.0 if e[9] == "Part-time" else 40.0
        timesheets.rows.append((i, e[0], week.isoformat(), hours, g.r.choice([0.0, 0.0, 0.0, 2.0, 4.5, 8.0]),
                                f"PRJ-{g.r.randint(100, 160)}"))

    leave = Table("leave_requests", [("leave_id", "int"), ("employee_id", "int"), ("leave_type", "text"),
                                     ("starts_on", "date"), ("days", "float"), ("approved", "bool")],
                  key="leave_id", joins=[("employee_id", "employees", "employee_id")], about="Time off.")
    for i in range(1, n(5000, scale) + 1):
        e = g.pick(employees.rows)
        leave.rows.append((i, e[0], g.pick(["Annual", "Annual", "Sick", "Parental", "Unpaid", "Study"]),
                           g.date_between(date.fromisoformat(e[7]), END).isoformat(), g.r.choice([0.5, 1.0, 2.0, 3.0, 5.0, 10.0]),
                           g.r.random() < 0.9))

    return [locations, departments, titles, employees, salary, reviews, timesheets, leave]


def logistics(g: Gen, scale: float) -> list[Table]:
    carriers = Table("carriers", [("carrier_id", "int"), ("carrier_name", "text"), ("mode", "text")], key="carrier_id",
                     about="Delivery companies.")
    for i, (name, mode) in enumerate([("Swift Freight", "Road"), ("BlueSea Lines", "Sea"), ("AirLink Cargo", "Air"),
                                      ("Metro Couriers", "Road"), ("Pacific Rail", "Rail"), ("Northline", "Road"),
                                      ("Skyhaul", "Air"), ("Harbour Shipping", "Sea")], 1):
        carriers.rows.append((i, name, mode))

    warehouses = Table("warehouses", [("warehouse_id", "int"), ("warehouse_name", "text"), ("city", "text"),
                                      ("country", "text"), ("capacity_pallets", "int")],
                       key="warehouse_id", about="Where stock is kept and shipped from.")
    for i, (city, country) in enumerate(g.r.sample(CITIES, 12), 1):
        warehouses.rows.append((i, f"{city} DC", city, country, g.r.randint(2, 40) * 500))

    suppliers = Table("suppliers", [("supplier_id", "int"), ("supplier_name", "text"), ("country", "text"),
                                    ("lead_time_days", "int"), ("rating", "float")],
                      key="supplier_id", about="Who stock is bought from. Some aren't rated yet.")
    for i in range(1, n(80, scale ** 0.5) + 1):
        suppliers.rows.append((i, g.company(), g.pick(CITIES)[1], g.r.randint(3, 60), g.maybe(round(g.r.uniform(2.5, 5), 1), 0.2)))

    products = Table("products", [("product_id", "int"), ("product_code", "text"), ("description", "text"),
                                  ("supplier_id", "int"), ("weight_kg", "float"), ("unit_cost", "float")],
                     key="product_id", joins=[("supplier_id", "suppliers", "supplier_id")], about="Stock items.")
    for i in range(1, n(600, scale ** 0.5) + 1):
        products.rows.append((i, f"P{i:06d}", f"{g.pick(WORDS)} {g.pick(['bolt', 'panel', 'cable', 'pump', 'valve', 'sensor', 'bracket', 'filter', 'motor', 'hinge'])}",
                              g.r.randint(1, len(suppliers.rows)), round(g.r.uniform(0.05, 80), 2), g.money(0.5, 900)))

    pos = Table("purchase_orders", [("po_id", "int"), ("supplier_id", "int"), ("warehouse_id", "int"),
                                    ("ordered_on", "date"), ("received_on", "date"), ("total_cost", "float")],
                key="po_id",
                joins=[("supplier_id", "suppliers", "supplier_id"), ("warehouse_id", "warehouses", "warehouse_id")],
                about="Stock bought into warehouses; received_on is empty until it arrives.")
    for i in range(1, n(5000, scale) + 1):
        supplier = g.pick(suppliers.rows)
        ordered = g.date_between(START, END)
        received = ordered + timedelta(days=supplier[3] + g.r.randint(-2, 10))
        pos.rows.append((i, supplier[0], g.r.randint(1, len(warehouses.rows)), ordered.isoformat(),
                         received.isoformat() if received <= END and g.r.random() < 0.97 else None, g.money(500, 80000)))

    shipments = Table("shipments", [("shipment_id", "int"), ("warehouse_id", "int"), ("carrier_id", "int"),
                                    ("destination_city", "text"), ("destination_country", "text"),
                                    ("shipped_at", "datetime"), ("delivered_at", "datetime"), ("freight_cost", "float")],
                      key="shipment_id",
                      joins=[("warehouse_id", "warehouses", "warehouse_id"), ("carrier_id", "carriers", "carrier_id")],
                      about="Outbound shipments; delivered_at is empty for ones still in transit.")
    lines = Table("shipment_lines", [("line_id", "int"), ("shipment_id", "int"), ("product_id", "int"),
                                     ("quantity", "int"), ("line_weight_kg", "float")],
                  key="line_id",
                  joins=[("shipment_id", "shipments", "shipment_id"), ("product_id", "products", "product_id")],
                  about="What each shipment carried: the largest table.")
    line_id = 0
    for i in range(1, n(12000, scale) + 1):
        city, country = g.pick(CITIES)
        carrier = g.r.randint(1, len(carriers.rows))
        shipped = g.moment(g.date_between(START, END, seasonal=True))
        transit = {"Air": 2, "Road": 4, "Rail": 7, "Sea": 25}[carriers.rows[carrier - 1][2]]
        delivered = shipped + timedelta(days=transit + g.r.randint(0, 6), hours=g.r.randint(0, 12))
        weight = 0.0
        for _ in range(g.r.choice([1, 2, 2, 3, 4, 5])):
            line_id += 1
            product = g.pick(products.rows)
            qty = g.r.randint(1, 50)
            weight += qty * product[4]
            lines.rows.append((line_id, i, product[0], qty, round(qty * product[4], 2)))
        shipments.rows.append((i, g.r.randint(1, len(warehouses.rows)), carrier, city, country, shipped.isoformat(sep=" "),
                               delivered.isoformat(sep=" ") if delivered.date() <= END and g.r.random() < 0.98 else None,
                               round(20 + weight * g.r.uniform(0.3, 1.2), 2)))

    return [carriers, warehouses, suppliers, products, pos, shipments, lines]


MODELS = {"retail": retail, "saas": saas, "hr": hr, "logistics": logistics}


# --- Messiness ----------------------------------------------------------------------------------


def plural(count: int, one: str, many: str) -> str:
    return one if count == 1 else many


def make_messy(g: Gen, tables: list[Table]) -> list[str]:
    """About 1% of rows get a real-world problem. Returns what was done, for the README."""
    notes = []
    by_name = {t.name: t for t in tables}
    for t in tables:
        if len(t.rows) < 200:
            continue
        hits = max(1, len(t.rows) // 100)
        # Foreign keys pointing at rows that don't exist (orphans).
        for column, other, _ in t.joins:
            if other == t.name:
                continue
            i = t.column_index(column)
            top = len(by_name[other].rows)
            changed = 0
            for row_index in g.r.sample(range(len(t.rows)), hits):
                row = list(t.rows[row_index])
                if row[i] is not None:
                    row[i] = top + g.r.randint(1, 500)
                    t.rows[row_index] = tuple(row)
                    changed += 1
            if changed:
                notes.append(f"{t.name}.{column}: {changed} {plural(changed, 'value points', 'values point')} at no {other} row")
        # Text with stray spaces, odd casing and blanks.
        text = [i for i, (_, kind) in enumerate(t.columns) if kind == "text" and i != 0]
        if text:
            i = g.pick(text)
            for row_index in g.r.sample(range(len(t.rows)), hits):
                row = list(t.rows[row_index])
                if isinstance(row[i], str):
                    row[i] = g.pick([f"  {row[i]} ", row[i].upper(), row[i].lower(), ""])
                    t.rows[row_index] = tuple(row)
            notes.append(f"{t.name}.{t.columns[i][0]}: {hits} {plural(hits, 'value', 'values')} with stray spaces, odd casing or blanks")
        # Exact duplicate rows (the key repeats too).
        dupes = max(1, hits // 4)
        t.rows.extend(g.r.sample(t.rows, dupes))
        notes.append(f"{t.name}: {dupes} duplicated {plural(dupes, 'row', 'rows')} (same key)")
    return notes


# --- Writing ------------------------------------------------------------------------------------


def write_csv(folder: Path, t: Table):
    folder.mkdir(parents=True, exist_ok=True)
    with open(folder / f"{t.name}.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow([c for c, _ in t.columns])
        for row in t.rows:
            w.writerow(["" if v is None else ("true" if v is True else "false" if v is False else v) for v in row])


def write_sqlite(path: Path, tables: list[Table], strict_keys: bool):
    path.unlink(missing_ok=True)
    con = sqlite3.connect(path)
    try:
        for t in tables:
            cols = []
            for name, kind in t.columns:
                cols.append(f'"{name}" {TYPES[kind]}' + (" PRIMARY KEY" if name == t.key and strict_keys else ""))
            if strict_keys:
                cols += [f'FOREIGN KEY ("{c}") REFERENCES "{o}" ("{oc}")' for c, o, oc in t.joins]
            con.execute(f'CREATE TABLE "{t.name}" ({", ".join(cols)})')
            con.executemany(f'INSERT INTO "{t.name}" VALUES ({", ".join("?" * len(t.columns))})', t.rows)
        con.commit()
    finally:
        con.close()


def write_parquet(folder: Path, t: Table):
    import pyarrow as pa
    import pyarrow.parquet as pq

    arrow = {"int": pa.int64(), "float": pa.float64(), "text": pa.string(), "date": pa.date32(),
             "datetime": pa.timestamp("s"), "bool": pa.bool_()}
    convert = {"date": lambda v: date.fromisoformat(v), "datetime": lambda v: datetime.fromisoformat(v)}
    columns = {}
    for i, (name, kind) in enumerate(t.columns):
        values = [row[i] for row in t.rows]
        if kind in convert:
            values = [None if v is None or v == "" else convert[kind](v) for v in values]
        columns[name] = pa.array(values, type=arrow[kind])
    folder.mkdir(parents=True, exist_ok=True)
    pq.write_table(pa.table(columns), folder / f"{t.name}.parquet")


def write_xlsx(path: Path, tables: list[Table]):
    from openpyxl import Workbook

    wb = Workbook(write_only=True)
    for t in tables:
        if len(t.rows) >= 1_048_576:
            print(f"  {t.name}: too many rows for an Excel sheet, left out of the workbook", file=sys.stderr)
            continue
        ws = wb.create_sheet(t.name[:31])
        ws.append([c for c, _ in t.columns])
        for row in t.rows:
            ws.append(list(row))
    wb.save(path)


def write_readme(path: Path, model: str, tables: list[Table], options: argparse.Namespace, notes: list[str]):
    lines = [f"# {model} test data", "",
             f"Generated by `scripts/test-data/make_test_data.py` (seed {options.seed}, scale {options.scale}"
             f"{', messy' if options.messy else ''}). Dates run from {START} to {END}.", "",
             "| Table | Rows | Key | Joins to | About |", "| --- | ---: | --- | --- | --- |"]
    for t in tables:
        joins = ", ".join(f"`{c}` → {o}.`{oc}`" for c, o, oc in t.joins) or "—"
        lines.append(f"| `{t.name}` | {len(t.rows):,} | `{t.key}` | {joins} | {t.about} |")
    lines += ["", "## Example: joining the largest table to the rest", ""]
    biggest = max(tables, key=lambda t: len(t.rows))
    select = [f"{biggest.name}.*"]
    joins = []
    for i, (c, o, oc) in enumerate(biggest.joins, 1):
        alias = f"j{i}"
        joins.append(f"LEFT JOIN {o} AS {alias} ON {alias}.{oc} = {biggest.name}.{c}")
        other = next(t for t in tables if t.name == o)
        label = next((name for name, kind in other.columns if kind == "text"), None)
        if label:
            select.append(f"{alias}.{label} AS {o}_{label}")
    lines += ["```sql", f"SELECT {', '.join(select)}", f"FROM {biggest.name}", *joins, "LIMIT 100", "```", ""]
    lines += ["## Loading it into PawpawBI", "",
              f"- **SQLite:** Add data → SQLite, and choose `{model}.sqlite`. Every table loads at once.",
              "- **Files on this computer:** choose the files in `csv/` (each becomes a table)"
              + (" or `parquet/`." if "parquet" in options.formats else "."), ""]
    if notes:
        lines += ["## Problems added (--messy)", "", *[f"- {note}" for note in notes], ""]
    path.write_text("\n".join(lines), encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Generate joinable test data for PawpawBI.")
    parser.add_argument("--models", default=",".join(MODELS))
    parser.add_argument("--scale", type=float, default=1.0)
    parser.add_argument("--formats", default="csv,sqlite")
    parser.add_argument("--messy", action="store_true")
    parser.add_argument("--out", default=str(Path(__file__).resolve().parents[2] / "test-data"))
    parser.add_argument("--seed", type=int, default=7)
    options = parser.parse_args(argv)
    options.formats = {f.strip() for f in options.formats.split(",") if f.strip()}
    unknown = options.formats - {"csv", "sqlite", "parquet", "xlsx"}
    models = [m.strip() for m in options.models.split(",") if m.strip()]
    if unknown or any(m not in MODELS for m in models) or options.scale <= 0:
        parser.error(f"models are {', '.join(MODELS)}; formats are csv, sqlite, parquet, xlsx; scale must be over 0")

    out = Path(options.out)
    for m, model in enumerate(models):
        g = Gen(options.seed * 1000 + m, options.messy)
        tables = MODELS[model](g, options.scale)
        notes = make_messy(g, tables) if options.messy else []
        folder = out / model
        folder.mkdir(parents=True, exist_ok=True)
        if "csv" in options.formats:
            for t in tables:
                write_csv(folder / "csv", t)
        if "sqlite" in options.formats:
            # Messy data breaks keys on purpose, so it gets no key constraints.
            write_sqlite(folder / f"{model}.sqlite", tables, strict_keys=not options.messy)
        if "parquet" in options.formats:
            for t in tables:
                write_parquet(folder / "parquet", t)
        if "xlsx" in options.formats:
            write_xlsx(folder / f"{model}.xlsx", tables)
        write_readme(folder / "README.md", model, tables, options, notes)
        total = sum(len(t.rows) for t in tables)
        biggest = max(tables, key=lambda t: len(t.rows))
        print(f"{model}: {len(tables)} tables, {total:,} rows (largest: {biggest.name}, {len(biggest.rows):,}) -> {folder}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
