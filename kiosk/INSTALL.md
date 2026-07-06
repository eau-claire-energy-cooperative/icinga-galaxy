# Raspberry Pi Kiosk

These are some basic instructions to getting a Raspberry Pi headless kiosk working. Assumed the basics of preparing a Raspberry Pi are understood. 

## System Configuration 
Prepare a fresh Raspberry Pi OS with Desktop. Configure the following: 

### Install Unclutter

```
sudo apt install unclutter-xfixes -y
```

### Auto Login

```
sudo raspi-config 

```

System Options → Boot / Auto Login → Desktop Autologin

### Disable Screen Blanking

```
sudo raspi-config 

```

Display Options → Screen Blanking → Disable

### Swap to X11

```
sudo raspi-config 

```

Advanced Options -> Wayland -> Choose X11

You will likely have to reboot after this step. 

## Create Auto Start Files

```
mkdir -p ~/.config/autostart

nano ~/.config/autostart/kiosk.desktop

```

Cut/paste the contents of the `kiosk.desktop` file. Make sure to modify the __username__ in the file paths. 

```
nano /home/[user]/kiosk.sh
```

Cut/paste the contents of the `kiosk.sh` file. Modify the __URL__ to match what you need. 

```
chmod +x kiosk.sh
```

## Test

Reboot the system with `sudo reboot`. It should reboot and load the URL specified. 