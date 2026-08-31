# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)

## 1.3

### Added

- Data can be encrypted during Icinga scraping via `--key` option, this keeps data hidden on web server if sensor file is accessed directly
- Data is decrypted in web interface by setting key in URL with `index.html#key=mykey`

## 1.2

### Added

- assign hosts into groups within spiral arms
- allow setting specific groups to use within Icinga file

### Changed

- changed flare cap to 8 or 50% of group
- treat downtime as an acknowledgement
- modified particle effects to mirror flare effects

## 1.1

### Added

- overall host status (up/down) added as a synthetic sensor
- display last update date/time in the web interface

### Changed

- reversed galaxy rotation to spiral arms follow trail

## 1.0

### Added

- Javascript `galaxy.js` file along with scraper `poll_icinga.py` file. 
- Added file to generate mock data