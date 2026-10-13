import * as EasyStar from 'easystarjs';

export interface Point {
    x: number;
    y: number;
}

export interface Rectangle {
    x: number;
    y: number;
    width: number;
    height: number;
}

export class Grid {
    public width: number;
    public height: number;
    public tileSize: number;
    private collisionMap: number[][]; // 0 = walkable, 1 = unwalkable
    private easystar: EasyStar.js;

    constructor(width: number, height: number, tileSize: number = 16) {
        this.width = width;
        this.height = height;
        this.tileSize = tileSize;

        // Initialize empty grid (all 0s)
        this.collisionMap = Array(height).fill(0).map(() => Array(width).fill(0));

        this.easystar = new EasyStar.js();
        this.easystar.setGrid(this.collisionMap);
        this.easystar.setAcceptableTiles([0]);
        // Allow diagonal movement? Default usually no for 4-directional agents
        // this.easystar.enableDiagonals();
    }

    public setCollision(x: number, y: number, isColliding: boolean): void {
        if (x >= 0 && x < this.width && y >= 0 && y < this.height) {
            this.collisionMap[y][x] = isColliding ? 1 : 0;
            this.easystar.setGrid(this.collisionMap);
        }
    }

    public findPath(startX: number, startY: number, endX: number, endY: number): Promise<Point[]> {
        return new Promise((resolve) => {
            this.easystar.findPath(startX, startY, endX, endY, (path) => {
                if (path === null) {
                    resolve([]); // No path found
                } else {
                    resolve(path);
                }
            });
            this.easystar.calculate();
        });
    }

    public isWalkable(x: number, y: number): boolean {
        if (x < 0 || x >= this.width || y < 0 || y >= this.height) return false;
        return this.collisionMap[y][x] === 0;
    }
}
