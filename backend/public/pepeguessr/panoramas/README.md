# PepeGuessr panorama drop folder

Create one folder per location.

Folder name format:

```text
build_2 overworld -1040 437
```

Also accepted:

```text
build_2 owerworld -1040 437
build_2_overworld_-1040_437
build_2 overworld -1040 437 spawn-road
```

Inside each folder, add six images.

Preferred numbered format:

```text
panorama_0.png - back
panorama_1.png - left
panorama_2.png - front
panorama_3.png - right
panorama_4.png - up
panorama_5.png - down
```

Named format also works:

```text
front.webp
back.webp
left.webp
right.webp
up.webp
down.webp
```

Supported extensions: `.webp`, `.png`, `.jpg`, `.jpeg`.

The game scans this folder automatically. After deploy, Vercel serves images from:

```text
/pepeguessr/panoramas/<folder-name>/<face>.webp
```
