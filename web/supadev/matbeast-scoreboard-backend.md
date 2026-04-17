# MatBeast Scoreboard Backend Structure Document

## Table of Contents

1. [Endpoints](#endpoints)
2. [Controllers and Services](#controllers-and-services)
3. [Database Schema](#database-schema)
4. [Data Flow](#data-flow)
5. [Third-party Integrations](#third-party-integrations)
6. [State Management Logic](#state-management-logic)
7. [Error Handling](#error-handling)
8. [API Documentation](#api-documentation)

---

## Endpoints

### API Routes

- **Team Setup**
  - **GET /api/teams**
    - Retrieves all teams.
    - **Response Example:**
      ```json
      [
        {
          "id": 1,
          "name": "Team A",
          "members": [...]
        },
        ...
      ]
      ```
  - **POST /api/teams**
    - Creates a new team.
    - **Request Example:**
      ```json
      {
        "name": "Team A",
        "members": [...]
      }
      ```

- **Roster Setup**
  - **GET /api/players**
    - Retrieves all player profiles.
    - **Response Example:**
      ```json
      [
        {
          "id": 101,
          "name": "John Doe",
          "teamId": 1,
          "weightClass": "Lightweight"
        },
        ...
      ]
      ```
  - **POST /api/players**
    - Creates a new player profile.
    - **Request Example:**
      ```json
      {
        "name": "John Doe",
        "teamId": 1,
        "weightClass": "Lightweight"
      }
      ```

- **Brackets Management**
  - **GET /api/brackets**
    - Retrieves the current bracket setup.
    - **Response Example:**
      ```json
      {
        "quarterFinals": [...],
        "semiFinals": [...],
        "finals": [...]
      }
      ```

- **Results Management**
  - **POST /api/results**
    - Submits match results.
    - **Request Example:**
      ```json
      {
        "matchId": 1001,
        "winnerPlayerId": 101,
        "loserPlayerId": 102,
        "round": "Quarter Final"
      }
      ```

- **Control and Overlay Management**
  - **GET /api/overlay/preview**
    - Retrieves a preview of the overlay output.
    - **Response Example:**
      ```json
      {
        "overlayData": "..."
      }
      ```

## Controllers and Services

### Controllers

- **TeamController**
  - Handles all operations related to team setup and management.
  
- **PlayerController**
  - Manages player profiles and roster setups.
  
- **BracketController**
  - Controls the creation and management of tournament brackets.
  
- **ResultController**
  - Processes and records match results.

- **OverlayController**
  - Manages the overlay preview and output operations.

### Services

- **TeamService**
  - Business logic for team creation, retrieval, and updates.

- **PlayerService**
  - Handles player data processing and validation.

- **BracketService**
  - Manages bracket logic including seeding and progression.

- **ResultService**
  - Processes match results and updates player statuses.

- **OverlayService**
  - Generates and manages overlay data for external use.

## Database Schema

### Tables

- **Teams**
  - `id`: Integer, Primary Key
  - `name`: String
  - `members`: Array of Player IDs

- **Players**
  - `id`: Integer, Primary Key
  - `name`: String
  - `teamId`: Integer, Foreign Key (Teams)
  - `weightClass`: String

- **Brackets**
  - `id`: Integer, Primary Key
  - `stage`: String (e.g., "Quarter Final")
  - `matchups`: Array of Match IDs

- **Results**
  - `id`: Integer, Primary Key
  - `matchId`: Integer, Foreign Key
  - `winnerPlayerId`: Integer, Foreign Key (Players)
  - `loserPlayerId`: Integer, Foreign Key (Players)
  - `round`: String

## Data Flow

1. **Request Initiation**: User interacts with the UI to create or manage tournament data.
2. **Controller Invocation**: The request hits the appropriate API endpoint and is handled by the corresponding controller.
3. **Service Processing**: The controller calls the relevant service to process the business logic.
4. **Database Interaction**: Services interact with the database to store or retrieve data.
5. **Response Generation**: Data is processed and sent back to the client as a response.

## Third-party Integrations

- **NDI Feed Software**: For overlay output, integrated via external software.
- **(Optional) Payment Gateways**: For any registration fees or premium features.
- **(Optional) Email Services**: For notifications and updates.

## State Management Logic

- **Session Management**: Utilizes cookies or JWT for user session management.
- **Caching Strategies**: Implemented using in-memory caching for frequently accessed data like player profiles or match results.

## Error Handling

- **Error Catching**: Try-catch blocks around service calls to capture exceptions.
- **Logging**: Errors are logged using a logging library (e.g., Winston) with different log levels.
- **Client Notification**: Errors are returned to the client with meaningful messages and appropriate HTTP status codes.

## API Documentation

The API is documented using the OpenAPI format, which can be converted to Swagger for interactive documentation.

- **OpenAPI Definition**: JSON/YAML file defining all endpoints, methods, parameters, and response schemas.
- **Swagger UI**: Hosted UI for exploring and testing the API, generated from the OpenAPI definition.

---

This document outlines the foundational structure of the backend for the MatBeast Scoreboard application, providing a comprehensive view of how the system operates and interacts internally and externally.