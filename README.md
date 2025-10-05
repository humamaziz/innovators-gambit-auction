# 🚀 Innovator's Gambit: A Startup Auction Challenge

**Tagline:** Bid. Build. Pitch. Prevail.

This repository contains the source code for a real-time, two-day hybrid event platform designed for university students. The application simulates a high-stakes Venture Capital (VC) auction where teams bid on startup assets, followed by a pitch competition where they must justify their strategic resource allocation.

The platform is built using **Node.js, Express, and Socket.IO** for real-time, authenticated gameplay and comprehensive administrator control.

## ✨ Features

### 1. Core Gameplay Mechanics
* **Multi-Unit Auction:** Teams bid a price per unit for assets with limited quantities. The system resolves the auction by awarding units to the top $N$ bidders at a uniform winning price (the lowest winning bid).
* **Financial Discipline Check:** The system verifies that a team's total cost of all won assets does not exceed their initial virtual VC budget. Teams failing this check have all wins **VOIDED**.
* **Real-time Updates:** Bids and the auction timer are synchronized instantly across all participant and admin dashboards via Socket.IO.
* **Fixed-Time Bidding:** The entire auction runs for a set duration (e.g., 30 minutes), set by the admin.

### 2. Technical & Administrative Features
* **Full Authentication:** Dedicated login screen for participants and administrators, ensuring secure access.
* **Admin Panel (CRUD):** Administrators can manage, add, edit, and delete Teams and Auction Assets without touching the code.
* **Game Control:** Admin controls include setting the auction duration, **START AUCTION**, **FORCE STOP & RESOLVE**, and **RESET ALL & SAVE GAME**.
* **Game History:** The system saves a snapshot of the full game state (assets, winners, final VC balances) after every reset, allowing the admin to review past challenge results.
* **Participant Dashboard:** Features a dedicated "My Assets" tab where teams can view the exact items and quantities they successfully won for their final pitch preparation.

## 🛠️ Technology Stack

* **Backend:** Node.js (v18+)
* **Web Framework:** Express.js
* **Real-time Communication:** Socket.IO
* **Frontend:** HTML5, CSS3, Vanilla JavaScript
* **State Persistence:** Local JSON file (`game_data.json`)
* **Hosting Target:** Render (or any platform supporting Node.js and WebSockets)

## 🚀 Getting Started (Local Development)

### Prerequisites

You must have Node.js and npm installed on your system.

```bash
# Verify installations
node -v
npm -v