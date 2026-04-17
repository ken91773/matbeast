# MatBeast Scoreboard Frontend Design Document

## Table of Contents
1. [Pages/Screens List](#pages/screens-list)
2. [Wireframes or Layout Descriptions](#wireframes-or-layout-descriptions)
3. [UI Components](#ui-components)
4. [Navigation Structure](#navigation-structure)
5. [Color Scheme & Fonts](#color-scheme--fonts)
6. [User Flow](#user-flow)
7. [Responsiveness](#responsiveness)
8. [State Management](#state-management)

---

## Pages/Screens List

1. **Home Page**
   - Introduction to the application and its features.
   - Quick access links to different sections of the app.

2. **Dashboard**
   - Central hub for tournament management.
   - Displays multiple cards for different functionalities.

3. **Team Setup**
   - Interface for adding and managing teams.
   - Input forms for team details.

4. **Roster Setup**
   - Player profile creation and management.
   - Form for entering player information.

5. **Brackets**
   - Visual representation of tournament brackets.
   - Update brackets as the tournament progresses.

6. **Results**
   - Display match results live.
   - Option to review past matches.

7. **Control Card**
   - Manage the scoreboard and timer.
   - Start, pause, and reset controls.

8. **Overlay Card**
   - Preview of the scoreboard overlay.
   - Configuration options for the overlay.

9. **Profile**
   - User account information and settings.
   - Edit profile details.

---

## Wireframes or Layout Descriptions

### Home Page
- **Header**: Application logo and navigation menu.
- **Main Section**: Introduction text and feature highlights.
- **Footer**: Contact information and links to social media.

### Dashboard
- **Header**: Navigation and user account options.
- **Cards Layout**: 
  - Grid layout with cards for each function (Team Setup, Roster Setup, etc.).
  - Each card has quick action buttons and status indicators.

### Team Setup
- **Form Layout**:
  - Input fields for team name, logo, and other details.
  - Submit and reset buttons.

### Roster Setup
- **List and Form**:
  - List of current players with options to edit or delete.
  - Form for adding new players with fields for name, rank, etc.

### Brackets
- **Bracket Visualization**:
  - Interactive tree structure showing matchups.
  - Clickable nodes to view match details.

### Results
- **Live Updates**:
  - Table layout displaying ongoing match results.
  - Historical results tab.

### Control Card
- **Controls**:
  - Timer display with start/stop/reset buttons.
  - Scoreboard preview.

### Overlay Card
- **Preview Window**:
  - Real-time view of the scoreboard overlay.
  - Options to configure appearance.

### Profile
- **User Info**:
  - Editable fields for username, email, etc.
  - Save changes button.

---

## UI Components

- **Buttons**: Primary, secondary, and icon buttons.
- **Modals**: Confirmation dialogs and input forms.
- **Forms**: Input fields with validation, dropdowns, and checkboxes.
- **Cards**: Container components for dashboard functionalities.
- **Tables**: For displaying lists and results.
- **Navigation Bar**: Top navigation with dropdowns.
- **Tabs**: For organizing content within a page.

---

## Navigation Structure

- **Horizontal Navigation Bar**:
  - Home
  - Dashboard
  - Profile
  - Logout

- **Dashboard Internal Navigation**:
  - Team Setup
  - Roster Setup
  - Brackets
  - Results
  - Control
  - Overlay

- **Routing Flow**:
  - `"/"`: Home Page
  - `"/dashboard"`: Dashboard
  - `"/profile"`: Profile

---

## Color Scheme & Fonts

- **Primary Colors**: 
  - Dark Blue (`#001F3F`)
  - Light Blue (`#007BFF`)

- **Secondary Colors**:
  - White (`#FFFFFF`)
  - Gray (`#6C757D`)

- **Typography**:
  - Primary Font: "Roboto", sans-serif
  - Secondary Font: "Open Sans", sans-serif

---

## User Flow

1. **Tournament Setup**:
   - User logs in and navigates to the dashboard.
   - Sets up teams and players via Team and Roster Setup cards.

2. **Tournament Progression**:
   - Monitors matches through Brackets and Results cards.
   - Controls matches using the Control Card.

3. **Scoreboard Management**:
   - Uses the Overlay Card to configure and preview the scoreboard.
   - Outputs the scoreboard to external software.

---

## Responsiveness

- **Mobile-First Approach**:
  - Prioritize mobile layout and enhance for larger screens.
  
- **Breakpoint Rules**:
  - Small: <768px
  - Medium: 768px - 1024px
  - Large: >1024px

- **Adaptive Layouts**:
  - Use grid and flexbox for responsive design.
  - Collapse side navigation into a drawer on smaller screens.

---

## State Management

- **State Handling**:
  - Use React Context for global state management.
  - Local component state for UI-specific interactions.
  - React Query for data fetching and caching.

This document provides a comprehensive guide for the frontend design of the MatBeast Scoreboard application. It outlines the pages, layouts, components, and user interactions necessary to build a responsive and functional user interface for managing jiu jitsu tournaments.