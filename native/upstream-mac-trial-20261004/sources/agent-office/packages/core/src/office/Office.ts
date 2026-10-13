import { Grid, Point, Rectangle } from './Grid';

export interface Room {
    id: string;
    name: string;
    bounds: Rectangle;
    type: 'workspace' | 'meeting' | 'social' | 'utility';
    capacity: number;
    ambientNoise: number;        // Affects agent focus
    lighting: number;            // Affects mood
}

export interface Furniture {
    id: string;
    type: string;
    bounds: Rectangle;
    interactionPoints: Point[];
}

export interface Zone {
    id: string;
    name: string;
    bounds: Rectangle;
    restricted: boolean;
}

export interface OfficeConfig {
    name: string;
    grid: {
        width: number;
        height: number;
        tileSize: number;
    };
    rooms: Room[];
    furniture: Furniture[];
    spawnPoints: Point[];
    zones: Zone[];
}

export class Office {
    public config: OfficeConfig;
    public grid: Grid;

    constructor(config: OfficeConfig) {
        this.config = config;
        this.grid = new Grid(config.grid.width, config.grid.height, config.grid.tileSize);
        this.initializeConstraints();
    }

    private initializeConstraints(): void {
        // Apply furniture collisions to the grid
        for (const item of this.config.furniture) {
            for (let y = item.bounds.y; y < item.bounds.y + item.bounds.height; y++) {
                for (let x = item.bounds.x; x < item.bounds.x + item.bounds.width; x++) {
                    this.grid.setCollision(x, y, true);
                }
            }
            // Assuming interaction points are walkable, free them up just in case
            for (const ip of item.interactionPoints) {
                this.grid.setCollision(ip.x, ip.y, false);
            }
        }
    }

    public getRoomAt(x: number, y: number): Room | undefined {
        return this.config.rooms.find(r =>
            x >= r.bounds.x && x < r.bounds.x + r.bounds.width &&
            y >= r.bounds.y && y < r.bounds.y + r.bounds.height
        );
    }
}
