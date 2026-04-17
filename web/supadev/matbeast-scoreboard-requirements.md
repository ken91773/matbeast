# Project Requirements Document: MatBeast Scoreboard

## Project Overview
MatBeast Scoreboard is a Windows Desktop application designed to manage and track jiu-jitsu tournaments. It facilitates the creation and maintenance of a database comprising player profiles and team information. The application manages tournament brackets, seeds, and updates results in real-time as the competition progresses. It also provides a scoreboard overlay feature that can be utilized by external software to generate an NDI feed. The user interface is designed as a dashboard with multiple interactive cards, allowing seamless management of various tournament aspects on a single page.

## Tech Stack and Tools
- **Front-end Framework**: Next.js
- **Backend Environment**: Node.js
- **Programming Languages**: JavaScript, TypeScript
- **Database**: SQLite
- **Styling**: Tailwind CSS
- **Data Fetching**: React Query

## Target Audience
- **Tournament Organizers**: Require a robust system to manage tournament logistics efficiently.
- **Coaches and Teams**: Need access to up-to-date information on brackets, matches, and results.
- **Broadcast Teams**: Utilize the overlay feature to enhance live broadcasts with real-time data.
- **Participants and Spectators**: Benefit from real-time updates and access to tournament progress.

## Features
- **Dashboard Interface**: 
  - Multiple cards for streamlined access to functionalities:
    - **Team Setup Card**: Manage team entries and configurations.
    - **Roster Setup Card**: Create and maintain player profiles.
    - **Brackets Card**: Set up and manage tournament brackets.
    - **Results Card**: Display and update match results.
    - **Control Card**: Manage scoreboard and match timers.
    - **Overlay Card**: Preview and configure the output for broadcasting.

- **Tournament Management**: 
  - Support for Quintet Team EBI rules with overtime.
  - Single and double elimination options.
  - Automatic progression tracking from Quarter Finals to Grand Final.

- **Match Handling**:
  - 4-minute matches with overtime rules.
  - System to handle tie-breakers through overtime periods.

- **Scoreboard Overlay**:
  - Real-time scoreboard output to a secondary window.
  - NDI feed compatibility for integration with broadcasting software.

## Authentication
- **User Accounts**: 
  - Users can sign up using an email and password.
  - Login functionality to access dashboard features.
  - Account management for resetting passwords and updating user information.

## New User Flow
1. **Sign Up**: User registers with email and password.
2. **Login**: User logs into the dashboard.
3. **Team Setup**: User creates new teams and configures settings.
4. **Roster Setup**: User adds players to the roster and creates profiles.
5. **Brackets Setup**: User organizes the tournament brackets.
6. **Live Management**: User manages matches, updates results, and controls the scoreboard.
7. **Broadcast**: User configures and previews the overlay for live streaming.

## Constraints
- **Technical Limitations**:
  - Compatibility with Windows Desktop environments only.
  - Requires a stable internet connection for real-time updates.

- **Browser Support**: 
  - Designed as a desktop application; browser compatibility is not applicable.

- **Performance Requirements**: 
  - Efficient handling of data updates and real-time processing for overlay generation.

## Known Issues
- **Current Bugs**:
  - Intermittent delays in data synchronization between dashboard cards.
  - Occasional UI layout misalignment on the overlay preview.

- **Limitations**:
  - Initial setup may require manual data entry for large tournaments.
  - Limited customization options for overlay aesthetics. 

This document serves as a comprehensive guide to the requirements and functionality of the MatBeast Scoreboard application, providing a detailed overview for developers and stakeholders involved in the project.