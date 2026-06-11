{
  "targets": [
    {
      "target_name": "preflow_drag_out",
      "sources": [
        "src/addon.cc"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS",
        "NAPI_VERSION=8",
        "UNICODE",
        "_UNICODE"
      ],
      "cflags!": [ "-fno-exceptions" ],
      "cflags_cc!": [ "-fno-exceptions" ],
      "conditions": [
        ["OS=='win'", {
          "libraries": [
            "ole32.lib",
            "shell32.lib",
            "uuid.lib",
            "oleaut32.lib"
          ],
          "msvs_settings": {
            "VCCLCompilerTool": {
              "ExceptionHandling": 0,
              "AdditionalOptions": [ "/std:c++17" ]
            }
          }
        }],
        ["OS=='mac'", {
          "sources!": [ "src/addon.cc" ],
          "sources": [ "src/addon_mac.mm" ],
          "xcode_settings": {
            "CLANG_ENABLE_OBJC_ARC": "YES",
            "GCC_ENABLE_CPP_EXCEPTIONS": "NO",
            "MACOSX_DEPLOYMENT_TARGET": "10.15",
            "OTHER_CPLUSPLUSFLAGS": [ "-std=c++17", "-stdlib=libc++" ]
          },
          "link_settings": {
            "libraries": [
              "$(SDKROOT)/System/Library/Frameworks/Cocoa.framework"
            ]
          }
        }],
        ["OS!='win' and OS!='mac'", {
          "sources!": [ "src/addon.cc" ],
          "sources": [ "src/addon_stub.cc" ]
        }]
      ]
    }
  ]
}
