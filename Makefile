UUID := gnomlets@prietus.github.io
SRC  := $(UUID)
DEST := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

.PHONY: install uninstall link zip enable disable prefs clean

## Copy the extension into ~/.local/share/gnome-shell/extensions
install: schemas
	rm -rf $(DEST)
	mkdir -p $(DEST)
	cp -r $(SRC)/* $(DEST)/
	@echo "Installed. Log out and back in (Wayland), then: make enable"

## Symlink instead of copying, for development
link: schemas
	rm -rf $(DEST)
	mkdir -p $(dir $(DEST))
	ln -s $(CURDIR)/$(SRC) $(DEST)

uninstall:
	-gnome-extensions disable $(UUID)
	rm -rf $(DEST)

schemas:
	glib-compile-schemas --strict $(SRC)/schemas

enable:
	gnome-extensions enable $(UUID)

disable:
	gnome-extensions disable $(UUID)

prefs:
	gnome-extensions prefs $(UUID)

## Package for extensions.gnome.org
zip:
	gnome-extensions pack --force --extra-source=lib --extra-source=widgets --out-dir=. $(SRC)

clean:
	rm -f $(SRC)/schemas/gschemas.compiled *.shell-extension.zip
