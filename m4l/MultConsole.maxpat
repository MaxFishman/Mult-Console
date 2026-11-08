{
	"patcher": {
		"fileversion": 1,
		"appversion": { "major": 8, "minor": 6, "revision": 0, "architecture": "x64", "modernui": 1 },
		"classnamespace": "box",
		"rect": [ 80.0, 80.0, 900.0, 600.0 ],
		"openinpresentation": 1,
		"default_fontsize": 12.0,
		"boxes": [
			{ "box": { "id": "obj-1", "maxclass": "newobj", "text": "live.thisdevice", "numinlets": 0, "numoutlets": 3, "outlettype": [ "bang", "bang", "int" ], "patching_rect": [ 20.0, 20.0, 100.0, 22.0 ] } },
			{ "box": { "id": "obj-2", "maxclass": "newobj", "text": "v8 mult-console.js", "numinlets": 1, "numoutlets": 2, "outlettype": [ "", "" ], "patching_rect": [ 300.0, 300.0, 140.0, 22.0 ] } },
			{ "box": { "id": "obj-3", "maxclass": "jweb", "text": "jweb mult-ui.html", "numinlets": 1, "numoutlets": 1, "outlettype": [ "" ], "patching_rect": [ 300.0, 380.0, 560.0, 180.0 ], "presentation": 1, "presentation_rect": [ 0.0, 0.0, 560.0, 300.0 ] } },

			{ "box": { "id": "obj-4", "maxclass": "newobj", "text": "ctlin", "numinlets": 1, "numoutlets": 3, "outlettype": [ "int", "int", "int" ], "patching_rect": [ 20.0, 80.0, 60.0, 22.0 ] } },
			{ "box": { "id": "obj-5", "maxclass": "newobj", "text": "pak 0 0 0", "numinlets": 3, "numoutlets": 1, "outlettype": [ "" ], "patching_rect": [ 20.0, 120.0, 80.0, 22.0 ] } },
			{ "box": { "id": "obj-6", "maxclass": "newobj", "text": "prepend cc", "numinlets": 1, "numoutlets": 1, "outlettype": [ "" ], "patching_rect": [ 20.0, 160.0, 80.0, 22.0 ] } },

			{ "box": { "id": "obj-7", "maxclass": "newobj", "text": "notein", "numinlets": 1, "numoutlets": 3, "outlettype": [ "int", "int", "int" ], "patching_rect": [ 140.0, 80.0, 60.0, 22.0 ] } },
			{ "box": { "id": "obj-8", "maxclass": "newobj", "text": "pak 0 0 0", "numinlets": 3, "numoutlets": 1, "outlettype": [ "" ], "patching_rect": [ 140.0, 120.0, 80.0, 22.0 ] } },
			{ "box": { "id": "obj-9", "maxclass": "newobj", "text": "prepend note", "numinlets": 1, "numoutlets": 1, "outlettype": [ "" ], "patching_rect": [ 140.0, 160.0, 90.0, 22.0 ] } },

			{ "box": { "id": "obj-11", "maxclass": "newobj", "text": "t 1", "numinlets": 1, "numoutlets": 1, "outlettype": [ "" ], "patching_rect": [ 20.0, 200.0, 40.0, 22.0 ] } },
			{ "box": { "id": "obj-10", "maxclass": "newobj", "text": "metro 16", "numinlets": 2, "numoutlets": 1, "outlettype": [ "bang" ], "patching_rect": [ 20.0, 240.0, 60.0, 22.0 ] } },
			{ "box": { "id": "obj-12", "maxclass": "newobj", "text": "t poll", "numinlets": 1, "numoutlets": 1, "outlettype": [ "" ], "patching_rect": [ 20.0, 280.0, 50.0, 22.0 ] } },

			{ "box": { "id": "obj-13", "maxclass": "newobj", "text": "route save", "numinlets": 1, "numoutlets": 2, "outlettype": [ "", "" ], "patching_rect": [ 460.0, 340.0, 80.0, 22.0 ] } },
			{ "box": { "id": "obj-17", "maxclass": "newobj", "text": "print mult-save", "numinlets": 1, "numoutlets": 0, "patching_rect": [ 460.0, 380.0, 100.0, 22.0 ] } },

			{ "box": { "id": "obj-14", "maxclass": "newobj", "text": "route led", "numinlets": 1, "numoutlets": 2, "outlettype": [ "", "" ], "patching_rect": [ 600.0, 300.0, 70.0, 22.0 ] } },
			{ "box": { "id": "obj-15", "maxclass": "newobj", "text": "unpack 0 0 0", "numinlets": 1, "numoutlets": 3, "outlettype": [ "int", "int", "int" ], "patching_rect": [ 600.0, 340.0, 90.0, 22.0 ] } },
			{ "box": { "id": "obj-16", "maxclass": "newobj", "text": "noteout", "numinlets": 3, "numoutlets": 0, "patching_rect": [ 600.0, 380.0, 60.0, 22.0 ] } },

			{ "box": { "id": "obj-20", "maxclass": "comment", "text": "Mult Console — MIDI control that follows Live's selected track", "numinlets": 1, "numoutlets": 0, "patching_rect": [ 140.0, 20.0, 420.0, 20.0 ] } }
		],
		"lines": [
			{ "patchline": { "source": [ "obj-4", 0 ], "destination": [ "obj-5", 0 ] } },
			{ "patchline": { "source": [ "obj-4", 1 ], "destination": [ "obj-5", 1 ] } },
			{ "patchline": { "source": [ "obj-4", 2 ], "destination": [ "obj-5", 2 ] } },
			{ "patchline": { "source": [ "obj-5", 0 ], "destination": [ "obj-6", 0 ] } },
			{ "patchline": { "source": [ "obj-6", 0 ], "destination": [ "obj-2", 0 ] } },

			{ "patchline": { "source": [ "obj-7", 0 ], "destination": [ "obj-8", 0 ] } },
			{ "patchline": { "source": [ "obj-7", 1 ], "destination": [ "obj-8", 1 ] } },
			{ "patchline": { "source": [ "obj-7", 2 ], "destination": [ "obj-8", 2 ] } },
			{ "patchline": { "source": [ "obj-8", 0 ], "destination": [ "obj-9", 0 ] } },
			{ "patchline": { "source": [ "obj-9", 0 ], "destination": [ "obj-2", 0 ] } },

			{ "patchline": { "source": [ "obj-1", 0 ], "destination": [ "obj-11", 0 ] } },
			{ "patchline": { "source": [ "obj-1", 0 ], "destination": [ "obj-2", 0 ] } },
			{ "patchline": { "source": [ "obj-11", 0 ], "destination": [ "obj-10", 0 ] } },
			{ "patchline": { "source": [ "obj-10", 0 ], "destination": [ "obj-12", 0 ] } },
			{ "patchline": { "source": [ "obj-12", 0 ], "destination": [ "obj-2", 0 ] } },

			{ "patchline": { "source": [ "obj-2", 0 ], "destination": [ "obj-3", 0 ] } },
			{ "patchline": { "source": [ "obj-2", 0 ], "destination": [ "obj-13", 0 ] } },
			{ "patchline": { "source": [ "obj-13", 0 ], "destination": [ "obj-17", 0 ] } },
			{ "patchline": { "source": [ "obj-3", 0 ], "destination": [ "obj-2", 0 ] } },

			{ "patchline": { "source": [ "obj-2", 1 ], "destination": [ "obj-14", 0 ] } },
			{ "patchline": { "source": [ "obj-14", 0 ], "destination": [ "obj-15", 0 ] } },
			{ "patchline": { "source": [ "obj-15", 0 ], "destination": [ "obj-16", 0 ] } },
			{ "patchline": { "source": [ "obj-15", 1 ], "destination": [ "obj-16", 1 ] } },
			{ "patchline": { "source": [ "obj-15", 2 ], "destination": [ "obj-16", 2 ] } }
		]
	}
}
