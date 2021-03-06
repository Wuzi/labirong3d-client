import * as BABYLON from '@babylonjs/core';

import Camera from '../entities/camera';
import Chatbox from '../network/chatbox';
import Ground from '../entities/ground';
import Player from '../entities/player';
import Skybox from '../entities/skybox';
import Sunlight from '../entities/sunlight';
import Torch from '../entities/torch';
import Wall from '../entities/wall';
import Network from '../network';
import Color from '../constants/color';
import { RemotePlayerDTO } from '../network/dto/remote-player.dto';

export default class GameplayScene {
  public readonly scene: BABYLON.Scene;

  public readonly ground: Ground;

  public readonly skybox: Skybox;

  public readonly camera: Camera;

  public readonly players: Player[] = [];

  public readonly music: BABYLON.Sound;

  private readonly completionSound: BABYLON.Sound;

  private hasEscaped: boolean;

  private grid: number[][] = [];

  private player: Player | undefined;

  private gate: BABYLON.Mesh | undefined;

  private walls: Wall[] = [];

  private characterMeshTask: BABYLON.MeshAssetTask;

  private textureTasks: BABYLON.TextureAssetTask[];

  private materials: BABYLON.StandardMaterial[];

  constructor(
    private readonly engine: BABYLON.Engine,
    private readonly canvas: HTMLCanvasElement,
    public readonly network: Network,
    playerOptions: { name: string; color: Color },
  ) {
    this.engine.displayLoadingUI();

    this.hasEscaped = false;
    this.scene = new BABYLON.Scene(this.engine);
    this.skybox = new Skybox(this.scene);
    this.ground = new Ground(this.scene);
    this.camera = new Camera(this.scene, this.canvas);

    this.completionSound = new BABYLON.Sound('Completion', 'assets/sounds/level-completion.ogg', this.scene, null);
    this.music = new BABYLON.Sound('Ambient Sound', 'assets/sounds/ambient.ogg', this.scene, null, {
      loop: true,
      autoplay: true,
    });

    this.materials = Object.values(Color).map((color) => new BABYLON.StandardMaterial(`character-${color}`, this.scene));

    // Create chatbox
    const chatbox = new Chatbox(this.canvas, this.network);

    // Lighting configuration
    const torch = new Torch(this.scene);
    torch.intensity = 1;

    const sunlight = new Sunlight(this.scene);
    sunlight.intensity = 0.5;

    // Load assets
    const assetsManager = new BABYLON.AssetsManager(this.scene);
    this.characterMeshTask = assetsManager.addMeshTask('characterMesh', '', 'assets/', 'character.babylon');

    const textures = [
      { name: 'character-red', filename: 'character-red.jpeg' },
      { name: 'character-blue', filename: 'character-blue.jpeg' },
      { name: 'character-green', filename: 'character-green.jpeg' },
      { name: 'character-yellow', filename: 'character-yellow.jpeg' },
    ];
    this.textureTasks = textures.map((texture) => assetsManager.addTextureTask(texture.name, `assets/textures/${texture.filename}`));

    assetsManager.onTasksDoneObservable.add((): void => {
      for (let i = 0; i < this.materials.length; i++) {
        this.materials[i].diffuseTexture = this.textureTasks[i].texture;
      }

      const colorIdx = Object.values(Color).findIndex((color) => color === playerOptions.color);

      this.player = new Player(
        this.scene,
        this.characterMeshTask.loadedMeshes[0],
        this.characterMeshTask.loadedSkeletons[0],
        this.materials[colorIdx],
        playerOptions,
        this.network,
      );
      this.player.position = this.getRandomSpawn();
      this.player.readControls();
      this.camera.lockTarget(this.player.mesh);

      // Do stuff before render
      this.scene.registerBeforeRender(() => {
        if (this.player) {
          this.player.move();
          torch.copyPositionFrom(this.player.position);

          if (!this.hasEscaped) {
            if (this.gate?.intersectsMesh(this.player.mesh, true)) {
              this.hasEscaped = true;
              this.network.send('onPlayerEscape');
            }
          }
        }
      });

      chatbox.show();
      chatbox.appendMessage('Welcome to Labirong!');
      chatbox.appendMessage('Try to find the exit.');
    });

    this.network.onConnect.add(() => {
      this.network.send('syncWorld');
    });

    this.network.onSyncWorld.add((data) => {
      data.players.forEach((remotePlayer: RemotePlayerDTO) => {
        this.addPlayer(remotePlayer);
      });
      this.grid = data.grid;
      this.spawnWalls();
      this.spawnGate();
      assetsManager.load();
    });

    this.network.onPlayerJoin.add((data) => {
      this.addPlayer(data.player);
    });

    this.network.onPlayerQuit.add((data) => {
      this.removePlayer(data.player.id);
    });

    this.network.onPlayerEscape.add((data) => {
      chatbox.appendMessage(`${data.player.name} has escaped the labyrinth!`);
      chatbox.appendMessage('Generating new map...');
      this.completionSound.play();
    });

    this.network.onMapRegen.add((data) => {
      this.engine.displayLoadingUI();
      this.grid = data.grid;
      this.hasEscaped = false;

      this.spawnWalls();
      this.spawnGate();

      if (this.player) {
        this.player.position = this.getRandomSpawn();
      }

      this.engine.hideLoadingUI();
    });

    this.network.onUpdate.add((data) => {
      data.players.forEach((remotePlayer: RemotePlayerDTO) => {
        const player = this.players.find((pl) => pl.id === remotePlayer.id);
        if (!player) return;

        player.position.x = remotePlayer.position.x;
        player.position.y = remotePlayer.position.y;
        player.position.z = remotePlayer.position.z;

        player.rotation.x = remotePlayer.rotation.x;
        player.rotation.y = remotePlayer.rotation.y;
        player.rotation.z = remotePlayer.rotation.z;

        player.playAnim(remotePlayer.currentAnimation);
      });
    });

    if (process.env.NODE_ENV === 'development') {
      this.scene.debugLayer.show();
    }
  }

  public getRandomSpawn(): BABYLON.Vector3 {
    const spawns = [];
    const position = new BABYLON.Vector3(0, 0, 8 - 64);

    for (let x = 0; x < this.grid.length; x++) {
      if (this.grid[x][1] === 0) {
        spawns.push(x);
      }
    }

    if (spawns.length > 0) {
      position.x = (spawns[Math.floor(Math.random() * spawns.length)] * 8) - 64;
    }

    return position;
  }

  private async addPlayer(remotePlayer: RemotePlayerDTO): Promise<void> {
    const { meshes, skeletons } = await BABYLON.SceneLoader.ImportMeshAsync('', 'assets/', 'character.babylon', this.scene);

    const playerOptions = {
      id: remotePlayer.id,
      name: remotePlayer.name,
      color: remotePlayer.color,
    };

    const colorIdx = Object.values(Color).findIndex((color) => color === playerOptions.color);

    const player = new Player(
      this.scene,
      meshes[0],
      skeletons[0],
      this.materials[colorIdx],
      playerOptions,
      this.network,
    );

    player.position.x = remotePlayer.position.x;
    player.position.y = remotePlayer.position.y;
    player.position.z = remotePlayer.position.z;

    player.rotation.x = remotePlayer.rotation.x;
    player.rotation.y = remotePlayer.rotation.y;
    player.rotation.z = remotePlayer.rotation.z;

    this.players.push(player);
  }

  private async removePlayer(id: number): Promise<void> {
    const player = this.players.find((p) => p.id === id);
    if (!player) return;

    this.players.splice(this.players.indexOf(player), 1);
    player.dispose();
  }

  private spawnWalls(): void {
    if (this.walls.length > 0) {
      this.walls.map((wall) => wall.dispose());
      this.walls = [];
    }

    const material = new BABYLON.StandardMaterial('', this.scene);
    material.diffuseTexture = new BABYLON.Texture('assets/textures/brick.png', this.scene);

    const options = {
      sideOrientation: BABYLON.Mesh.DOUBLESIDE,
      pattern: BABYLON.Mesh.FLIP_TILE,
      alignVertical: BABYLON.Mesh.TOP,
      alignHorizontal: BABYLON.Mesh.LEFT,
      width: 8,
      height: 16,
      depth: 8,
      tileSize: 1,
      tileWidth: 3,
    };

    const box = BABYLON.MeshBuilder.CreateTiledBox('', options, this.scene);
    box.material = material;
    box.position.y = -10;

    this.grid.forEach((tiles, x) => {
      tiles.forEach((tile, z) => {
        if (tile === 1) {
          const wall = new Wall(box);
          wall.position = new BABYLON.Vector3((x * 8) - 64, 0, (z * 8) - 64);
          this.walls.push(wall);
        }
      });
    });
  }

  private spawnGate(): void {
    if (this.gate) {
      this.gate.dispose();
    }

    const material = new BABYLON.StandardMaterial('', this.scene);
    material.diffuseTexture = new BABYLON.Texture('assets/textures/gate.jpg', this.scene);

    const options = {
      sideOrientation: BABYLON.Mesh.DOUBLESIDE,
      pattern: BABYLON.Mesh.FLIP_TILE,
      alignVertical: BABYLON.Mesh.TOP,
      alignHorizontal: BABYLON.Mesh.LEFT,
      width: 8,
      height: 16,
      depth: 8,
      tileSize: 8,
      tileWidth: 16,
    };

    this.gate = BABYLON.MeshBuilder.CreateTiledBox('gate', options, this.scene);
    this.gate.material = material;

    this.grid.forEach((tiles, x) => {
      tiles.forEach((tile, z) => {
        if (z === this.grid.length - 1 && tile === 0 && this.gate) {
          this.gate.position = new BABYLON.Vector3((x * 8) - 64, 0, (z * 8) - 64);
          this.gate.checkCollisions = true;
        }
      });
    });
  }
}
